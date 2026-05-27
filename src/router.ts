/**
 * Inbound message routing.
 *
 * Channel adapter event → resolve messaging group → sender resolver →
 * resolve/pick agent → access gate → resolve/create session → write
 * messages_in → wake container.
 *
 * Cloud mode (NANOCLAW_ENV=cloud): after the access gate, messages are
 * rate-limited and enqueued to Redis for sub-agent pickup instead of
 * writing to SQLite session DBs.
 *
 * Two module hooks (registered by the permissions module):
 *   - `setSenderResolver` runs BEFORE agent resolution so user rows get
 *     upserted even if the message ends up dropped by agent wiring.
 *     Without the module, userId is null and downstream code tolerates it.
 *   - `setAccessGate` runs AFTER agent resolution so policy decisions can
 *     branch on the target agent group. Without the module, access is
 *     allow-all.
 *
 * `dropped_messages` is core audit infra. Core writes rows for structural
 * drops (no agent wired, no trigger match); the access gate writes rows
 * for policy refusals.
 *
 * -- Isolation guarantees (data-isolation-corporate-docs Req 5) --
 *  1. The router NEVER infers userId from message content; it is derived
 *     ONLY from `senderResolver(event)`, which inspects the channel-level
 *     sender identity (e.g. WhatsApp phone number). A spoofed inline
 *     'I am user-X' payload cannot redirect routing.
 *  2. Unrecognized senders yield userId=null, and downstream cloud-mode
 *     enqueue is gated by `if (isCloudMode() && wake && userId)` -- so
 *     unknown senders are NEVER routed to any per-user sub-agent queue.
 *  3. `enqueueForAgent(userId, ...)` writes to `agent:{userId}:inbound`.
 *     Each sub-agent only consumes its own queue (assigned at container
 *     startup). There is no cross-user fan-out.
 *  4. Sub-agents calling DataGateway carry their assigned userId; the
 *     gateway's `assertUserId` rejects empty/CORPORATE values, and
 *     `assertKeyBelongsToUser` enforces the userId/ S3 prefix on writes.
 */
import { getChannelAdapter } from './channels/channel-registry.js';
import { isCloudMode, getCloudServices } from './cloud/bootstrap.js';
import { gateCommand } from './command-gate.js';
import { getAgentGroup } from './db/agent-groups.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import {
  createMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupWithAgentCount,
} from './db/messaging-groups.js';
import { findSessionForAgent } from './db/sessions.js';
import { startTypingRefresh, stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage, writeOutboundDirect } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from './types.js';
import type { InboundEvent } from './channels/adapter.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sender-resolver hook. Runs before agent resolution.
 *
 * The permissions module registers this to extract the sender's namespaced
 * user id and upsert the users row. Returns null when the payload doesn't
 * carry enough info to identify a sender. Without the hook, every message
 * arrives at the gate with userId=null.
 */
export type SenderResolverFn = (event: InboundEvent) => string | null;

let senderResolver: SenderResolverFn | null = null;

export function setSenderResolver(fn: SenderResolverFn): void {
  if (senderResolver) {
    log.warn('Sender resolver overwritten');
  }
  senderResolver = fn;
}

/**
 * Access-gate hook. Runs after agent resolution.
 *
 * The permissions module registers this; without it, core defaults to
 * allow-all. The gate receives the raw event so it can extract the sender
 * name for audit-trail purposes, and it is responsible for recording its
 * own `dropped_messages` row on refusal (structural drops are already
 * recorded by core before the gate runs).
 */
export type AccessGateResult = { allowed: true } | { allowed: false; reason: string };

export type AccessGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agentGroupId: string,
) => AccessGateResult;

let accessGate: AccessGateFn | null = null;

export function setAccessGate(fn: AccessGateFn): void {
  if (accessGate) {
    log.warn('Access gate overwritten');
  }
  accessGate = fn;
}

/**
 * Per-wiring sender-scope hook. Runs alongside the access gate for each
 * agent that would otherwise engage — lets the permissions module enforce
 * `sender_scope='known'` on wirings that are stricter than the messaging
 * group's `unknown_sender_policy`. When the hook isn't registered (module
 * not installed), sender_scope is a no-op.
 */
export type SenderScopeGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agent: MessagingGroupAgent,
) => AccessGateResult;

let senderScopeGate: SenderScopeGateFn | null = null;

export function setSenderScopeGate(fn: SenderScopeGateFn): void {
  if (senderScopeGate) {
    log.warn('Sender-scope gate overwritten');
  }
  senderScopeGate = fn;
}

/**
 * Message-interceptor hook. Runs at the very top of routeInbound, before
 * messaging-group resolution. When the interceptor returns true the message
 * is consumed and routing stops. Used by the permissions module to capture
 * free-text replies during multi-step approval flows (e.g. agent naming).
 */
export type MessageInterceptorFn = (event: InboundEvent) => Promise<boolean>;

let messageInterceptor: MessageInterceptorFn | null = null;

export function setMessageInterceptor(fn: MessageInterceptorFn): void {
  messageInterceptor = fn;
}

/**
 * Channel-registration hook. Runs when the router sees a mention/DM on a
 * messaging group that has no wirings AND hasn't been denied. The hook is
 * expected to escalate to an owner (card, etc.) and arrange for future
 * replay via routeInbound after approval. Fire-and-forget from the
 * router's perspective.
 *
 * Registered by the permissions module. Without the module the router
 * silently records the drop with reason='no_agent_wired' and moves on.
 */
export type ChannelRequestGateFn = (mg: MessagingGroup, event: InboundEvent) => Promise<void>;

let channelRequestGate: ChannelRequestGateFn | null = null;

export function setChannelRequestGate(fn: ChannelRequestGateFn): void {
  if (channelRequestGate) {
    log.warn('Channel-request gate overwritten');
  }
  channelRequestGate = fn;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  // Pre-route interceptor — lets modules consume messages before any routing
  // (e.g. free-text replies during multi-step approval flows).
  if (messageInterceptor && (await messageInterceptor(event))) return;

  // 0. Apply the adapter's thread policy. Non-threaded adapters (Telegram,
  //    WhatsApp, iMessage, email) collapse threads to the channel.
  const adapter = getChannelAdapter(event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  }

  const isMention = event.message.isMention === true;

  // 1. Combined lookup: messaging_group row + count of wired agents in a
  //    single query. Cheap short-circuit for the common "unwired channel"
  //    case — one DB read and we're out, no auto-create, no sender
  //    resolution, no log spam.
  const found = getMessagingGroupWithAgentCount(event.channelType, event.platformId);

  let mg: MessagingGroup;
  let agentCount: number;
  if (!found) {
    // No messaging_groups row. Auto-create only when the message warrants
    // attention (the bot was addressed — @mention or DM). Plain chatter in
    // channels we merely sit in stays silent — no row, no DB writes.
    if (!isMention) return;
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      name: null,
      is_group: event.message.isGroup ? 1 : 0,
      unknown_sender_policy: 'request_approval',
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Auto-created messaging group', {
      id: mgId,
      channelType: event.channelType,
      platformId: event.platformId,
    });
    agentCount = 0;
  } else {
    mg = found.mg;
    agentCount = found.agentCount;
  }

  // 1b. No wirings — either silent drop (plain chatter / denied channel) or
  //     escalate to owner for channel-registration approval.
  if (agentCount === 0) {
    if (!isMention) return;
    if (mg.denied_at) {
      log.debug('Message dropped — channel was denied by owner', {
        messagingGroupId: mg.id,
        deniedAt: mg.denied_at,
      });
      return;
    }

    const parsed = safeParseContent(event.message.content);
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: null,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_wired',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });

    if (channelRequestGate) {
      // Fire-and-forget escalation. The gate is expected to build a card,
      // persist pending_channel_approvals, and replay the event via
      // routeInbound after approval. Errors are logged internally — the
      // user's message still stays dropped here either way.
      void channelRequestGate(mg, event).catch((err) =>
        log.error('Channel-request gate threw', { messagingGroupId: mg.id, err }),
      );
    } else {
      log.warn('MESSAGE DROPPED — no agent groups wired and no channel-request gate registered', {
        messagingGroupId: mg.id,
        channelType: event.channelType,
        platformId: event.platformId,
      });
    }
    return;
  }

  // 2. Sender resolution (permissions module upserts the users row as a
  //    side effect so later role/access lookups find a real record).
  //    Without the module, userId is null — downstream tolerates it.
  const userId: string | null = senderResolver ? senderResolver(event) : null;

  // Parse message content early — needed for rate limit drops and fan-out.
  const parsed = safeParseContent(event.message.content);

  // 2b. Cloud mode: rate limit check before processing.
  // Rejects messages that exceed per-user (20/min) or global (200/hr) limits.
  if (isCloudMode() && userId) {
    const services = getCloudServices();
    if (services) {
      try {
        const rateLimitResult = await services.rateLimiter.checkLimit(userId);
        if (!rateLimitResult.allowed) {
          log.info('Message rate-limited', {
            userId,
            reason: rateLimitResult.reason,
            retryAfterMs: rateLimitResult.retryAfterMs,
          });
          recordDroppedMessage({
            channel_type: event.channelType,
            platform_id: event.platformId,
            user_id: userId,
            sender_name: parsed.sender ?? null,
            reason: 'rate_limited',
            messaging_group_id: mg.id,
            agent_group_id: null,
          });
          return;
        }
        // Record the message for rate limiting tracking
        await services.rateLimiter.recordMessage(userId);
      } catch (err) {
        // Rate limiter failure is non-critical — allow the message through
        log.warn('Rate limiter check failed, allowing message', { userId, err });
      }
    }
  }

  // 3. Fetch wired agents in full (we already know the count is > 0; now
  //    we need their actual rows for fan-out).
  const agents = getMessagingGroupAgents(mg.id);

  // 4. Fan-out: evaluate each wired agent independently against engage_mode,
  //    sender_scope, and access gate. An agent that engages gets its own
  //    session and container wake. An agent that declines but has
  //    ignored_message_policy='accumulate' still gets the message stored in
  //    its session (trigger=0) so the context is available when it does
  //    engage later. Drop policy = skip silently.
  //
  //    Subscribe (for mention-sticky wirings on threaded platforms) fires
  //    once per message from this loop — the first engaging mention-sticky
  //    wiring triggers adapter.subscribe(...); subsequent wirings don't
  //    re-subscribe (chat.subscribe is idempotent anyway, but the flag
  //    avoids the extra await).
  const messageText = parsed.text ?? '';

  let engagedCount = 0;
  let accumulatedCount = 0;
  let subscribed = false;

  for (const agent of agents) {
    const agentGroup = getAgentGroup(agent.agent_group_id);
    if (!agentGroup) continue;

    const engages = evaluateEngage(agent, messageText, isMention, mg, event.threadId);

    const accessOk = engages && (!accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed);
    const scopeOk = engages && (!senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed);

    if (engages && accessOk && scopeOk) {
      await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, true);
      engagedCount++;

      // Mention-sticky: ask the adapter to subscribe the thread so the
      // platform's subscribed-message path carries follow-ups without
      // requiring another @mention. Threaded-adapter only; DMs and
      // non-threaded platforms skip.
      if (
        !subscribed &&
        agent.engage_mode === 'mention-sticky' &&
        adapter?.supportsThreads &&
        adapter.subscribe &&
        event.threadId !== null &&
        mg.is_group !== 0
      ) {
        subscribed = true;
        // Fire-and-forget — subscribe is platform-side bookkeeping and
        // shouldn't block message routing. Errors are logged inside the
        // adapter (or by the promise rejection handler below).
        void adapter.subscribe(event.platformId, event.threadId).catch((err) => {
          log.warn('adapter.subscribe failed', { channelType: event.channelType, threadId: event.threadId, err });
        });
      }
    } else if (agent.ignored_message_policy === 'accumulate' && !(engages && (!accessOk || !scopeOk))) {
      // Accumulate stores the message as silent context. We allow it when
      // engagement simply didn't fire, but NOT when engagement fired and
      // the access/scope gate refused — those refusals are security
      // decisions about an untrusted sender, and silently storing their
      // message (which also stages their attachments to disk via
      // writeSessionMessage → extractAttachmentFiles) is exactly what the
      // gate is meant to prevent.
      await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, false);
      accumulatedCount++;
    } else {
      log.debug('Message not engaged for agent (drop policy)', {
        agentGroupId: agent.agent_group_id,
        engage_mode: agent.engage_mode,
        engages,
        accessOk,
        scopeOk,
      });
    }
  }

  if (engagedCount + accumulatedCount === 0) {
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_engaged',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
  }
}

/**
 * Decide whether a given wired agent should engage on this message.
 *
 *   'pattern'        — regex test on text; '.' = always
 *   'mention'        — bot must be mentioned on the platform. Resolved by
 *                      the adapter (SDK-level) and forwarded as
 *                      `event.message.isMention`. Agent display name
 *                      (`agent_group.name`) is irrelevant — users address
 *                      the bot via its platform username (@botname on
 *                      Telegram, user-id mention on Slack/Discord), not
 *                      via the agent's NanoClaw-side display name. If a
 *                      user wants to disambiguate between multiple agents
 *                      wired to one chat, use engage_mode='pattern' with
 *                      the disambiguator as the regex.
 *   'mention-sticky' — platform mention OR an active per-thread session
 *                      already exists for this (agent, mg, thread). The
 *                      session existence IS our subscription state; once
 *                      a thread has engaged us once, follow-ups arrive
 *                      with no mention and should still fire.
 */
function evaluateEngage(
  agent: MessagingGroupAgent,
  text: string,
  isMention: boolean,
  mg: MessagingGroup,
  threadId: string | null,
): boolean {
  switch (agent.engage_mode) {
    case 'pattern': {
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try {
        // Case-insensitive by default: mention rendering is platform-controlled
        // (Telegram/WhatsApp/Discord all surface bot handles in display-name
        // case, which admins can't predict). Admins who genuinely need
        // case-sensitive matching can express it via character classes,
        // e.g. \`[Pp]ocketclaw\`. Without \`i\`, a wiring with pattern
        // \`@pocketclaw\` silently drops every \`@PocketClaw\` from the
        // WhatsApp adapter (which rewrites mention text to ASSISTANT_NAME).
        return new RegExp(pat, 'i').test(text);
      } catch {
        // Bad regex: fail open so admin sees the agent responding + can fix.
        return true;
      }
    }
    case 'mention':
      return isMention;
    case 'mention-sticky': {
      if (isMention) return true;
      // Sticky follow-up: session already exists for this (agent, mg, thread)
      // — the thread was activated before, keep firing.
      if (mg.is_group === 0) return false; // DMs never use mention-sticky sensibly
      const existing = findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      return existing !== undefined;
    }
    default:
      return false;
  }
}

async function deliverToAgent(
  agent: MessagingGroupAgent,
  agentGroup: AgentGroup,
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  adapterSupportsThreads: boolean,
  wake: boolean,
): Promise<void> {
  // Apply the adapter thread policy: threaded adapter in a group chat →
  // per-thread session regardless of wiring. agent-shared preserved (it's
  // a cross-channel directive the adapter doesn't know about). DMs collapse
  // sub-threads to one session (is_group=0 short-circuit).
  let effectiveSessionMode = agent.session_mode;
  if (adapterSupportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }

  const { session, created } = resolveSession(agent.agent_group_id, mg.id, event.threadId, effectiveSessionMode);

  // The inbound row's (channel_type, platform_id, thread_id) is the address
  // the agent's reply will be delivered to. Normally it mirrors the source
  // (stamped from the event). When the caller supplied `replyTo` (CLI admin
  // transport acting on operator intent), the reply is redirected there.
  const deliveryAddr = event.replyTo ?? {
    channelType: event.channelType,
    platformId: event.platformId,
    threadId: event.threadId,
  };

  // Command gate: classify slash commands before they reach the container.
  // Filtered commands are dropped silently. Denied admin commands get a
  // permission-denied response written directly to messages_out.
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const gate = gateCommand(event.message.content, userId, agent.agent_group_id);
    if (gate.action === 'filter') {
      log.debug('Filtered command dropped by gate', { agentGroupId: agent.agent_group_id });
      return;
    }
    if (gate.action === 'deny') {
      writeOutboundDirect(session.agent_group_id, session.id, {
        id: `deny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: `Permission denied: ${gate.command} requires admin access.` }),
      });
      log.info('Admin command denied by gate', { command: gate.command, userId, agentGroupId: agent.agent_group_id });
      return;
    }
  }

  // Cloud mode: enqueue to Redis for sub-agent pickup.
  // Local mode: write to SQLite session DB and wake container.
  if (isCloudMode() && wake && userId) {
    const services = getCloudServices();
    if (services) {
      try {
        // Check backpressure before enqueuing
        const backpressured = await services.messageQueue.isBackpressured(userId);
        if (backpressured) {
          log.warn('Queue backpressured for user, message will be delayed', { userId, sessionId: session.id });
        }

        const messageId = messageIdForAgent(event.message.id, agent.agent_group_id);
        await services.messageQueue.enqueueForAgent(userId, {
          id: messageId,
          userId,
          type: event.message.kind,
          payload: {
            sessionId: session.id,
            agentGroupId: agent.agent_group_id,
            kind: event.message.kind,
            content: event.message.content,
            timestamp: event.message.timestamp,
            channelType: deliveryAddr.channelType,
            platformId: deliveryAddr.platformId,
            threadId: deliveryAddr.threadId,
          },
          timestamp: event.message.timestamp,
        });

        log.info('Message enqueued to Redis', {
          sessionId: session.id,
          agentGroup: agent.agent_group_id,
          engage_mode: agent.engage_mode,
          kind: event.message.kind,
          userId,
          agentGroupName: agentGroup.name,
        });

        // Start typing indicator for cloud mode too
        startTypingRefresh(session.id, session.agent_group_id, event.channelType, event.platformId, event.threadId);
        return;
      } catch (err) {
        // Redis enqueue failed — fall through to local mode as graceful degradation
        log.error('Redis enqueue failed, falling back to local mode', { userId, err });
      }
    }
  }

  // Local mode (or cloud fallback): write to SQLite session DB
  writeSessionMessage(session.agent_group_id, session.id, {
    id: messageIdForAgent(event.message.id, agent.agent_group_id),
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content: event.message.content,
    trigger: wake ? 1 : 0,
  });

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: agent.agent_group_id,
    engage_mode: agent.engage_mode,
    kind: event.message.kind,
    userId,
    wake,
    created,
    agentGroupName: agentGroup.name,
  });

  if (wake) {
    // Typing indicator + wake are only for the engaged branch; accumulated
    // messages sit silently until a real trigger fires.
    startTypingRefresh(session.id, session.agent_group_id, event.channelType, event.platformId, event.threadId);
    const freshSession = getSession(session.id);
    if (freshSession) {
      const woke = await wakeContainer(freshSession);
      // wakeContainer never throws — it returns false on transient spawn
      // failure (host-sweep retries). Stop the typing indicator we just
      // started so it doesn't leak; the inbound row stays pending.
      if (!woke) stopTypingRefresh(freshSession.id);
    }
  }
}

/**
 * When fanning out, the same inbound message lands in multiple per-agent
 * session DBs. messages_in.id is PRIMARY KEY, so reuse of the raw id would
 * collide across sessions (or, more subtly, within one session if re-routed
 * after a retry). Namespace by agent_group_id to keep ids unique per session.
 */
function messageIdForAgent(baseId: string | undefined, agentGroupId: string): string {
  const id = baseId && baseId.length > 0 ? baseId : generateId();
  return `${id}:${agentGroupId}`;
}
