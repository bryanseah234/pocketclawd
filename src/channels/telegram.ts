/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with a pairing
 * interceptor wrapped around onInbound to verify chat ownership before
 * registration. See telegram-pairing.ts for the why.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../db/messaging-groups.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';
import {
  startConnect,
  submitCode,
  submitPassword,
  cancel as cancelConnect,
} from '../modules/telegram-mtproto-service.js';

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

/** Look up the bot username via Telegram getMe. Cached after first call. */
async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

/**
 * Build an onInbound interceptor that consumes pairing codes before they
 * reach the router. On match: records the chat + its paired user, promotes
 * the user to owner if the instance has no owner yet, and short-circuits.
 * On miss: forwards to the host.
 */
/**
 * Send a one-shot confirmation back to the paired chat. Best-effort — failures
 * are logged but never propagated, so a Telegram outage can't undo a successful
 * pairing or trigger the interceptor's fail-open path.
 */
async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Pairing success! Head back to the NanoClaw installer to finish setup.',
      }),
    });
    if (!res.ok) {
      log.warn('Telegram pairing confirmation non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram pairing confirmation failed', { err });
  }
}

/**
 * Send arbitrary text to a chat via the bot. Used by the connect flow.
 * Failures are logged, not propagated.
 */
async function sendBotMessage(token: string, platformId: string, text: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      log.warn('Bot sendMessage non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Bot sendMessage failed', { err });
  }
}

/**
 * Per-chat state machine for the /connect_telegram flow. Lets the user
 * complete a multi-step sign-in by replying to the bot in plain text after
 * the initial slash command.
 */
type ConnectStage = 'awaiting_phone' | 'awaiting_code' | 'awaiting_password';
const connectState = new Map<string, ConnectStage>(); // platformId -> stage

interface HandleConnectArgs {
  text: string;
  platformId: string;
  token: string;
  authorUserId: string | null;
}

/**
 * Try to consume the message as part of a /connect_telegram flow.
 * Returns true if the message was handled (and routing should stop),
 * false if it should fall through to normal pairing/routing.
 */
async function tryHandleConnectFlow(args: HandleConnectArgs): Promise<boolean> {
  const { text, platformId, token, authorUserId } = args;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Slash commands always take precedence over conversation state.
  if (lower === '/connect_telegram' || lower.startsWith('/connect_telegram ')) {
    connectState.set(platformId, 'awaiting_phone');
    await sendBotMessage(
      token,
      platformId,
      [
        '🔌 Telegram MTProto sign-in',
        '',
        'This signs PocketClaw in AS YOU so it can read your DMs and group history.',
        '⚠️ Treat the resulting session like a password — anyone with it can read your Telegram.',
        '',
        'Reply with your phone number in international format (e.g. +6592348112).',
        'Send /cancel to abort.',
      ].join('\n'),
    );
    return true;
  }

  if (lower === '/cancel' || lower === '/cancel_telegram') {
    if (connectState.has(platformId)) {
      cancelConnect(authorUserId ?? platformId);
      connectState.delete(platformId);
      await sendBotMessage(token, platformId, '✋ Sign-in cancelled.');
      return true;
    }
    // No flow in progress — let normal routing handle this
    return false;
  }

  const stage = connectState.get(platformId);
  if (!stage) return false;

  // Now we're inside an in-progress flow; the message is one of:
  // (a) phone number → kick off MTProto + Telegram texts the code
  // (b) SMS code → submit, may need 2FA password next
  // (c) 2FA password → submit, finish
  const userKey = authorUserId ?? platformId;

  if (stage === 'awaiting_phone') {
    const phone = trimmed.replace(/[\s-]/g, '');
    if (!/^\+?\d{8,15}$/.test(phone)) {
      await sendBotMessage(
        token,
        platformId,
        'That doesn\'t look like a phone number. Send international format like +6592348112, or /cancel to abort.',
      );
      return true;
    }
    const phoneE164 = phone.startsWith('+') ? phone : `+${phone}`;
    await sendBotMessage(token, platformId, `📱 Texting a code to ${phoneE164}...`);
    const result = await startConnect(userKey, phoneE164);
    if (result.step === 'awaiting_code') {
      connectState.set(platformId, 'awaiting_code');
    } else {
      connectState.delete(platformId);
    }
    await sendBotMessage(token, platformId, result.message);
    return true;
  }

  if (stage === 'awaiting_code') {
    const result = await submitCode(userKey, trimmed);
    if (result.step === 'awaiting_password') {
      connectState.set(platformId, 'awaiting_password');
    } else {
      connectState.delete(platformId);
    }
    await sendBotMessage(token, platformId, result.message);
    return true;
  }

  if (stage === 'awaiting_password') {
    const result = await submitPassword(userKey, trimmed);
    connectState.delete(platformId);
    await sendBotMessage(token, platformId, result.message);
    return true;
  }

  return false;
}

function createPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }

      // PocketClaw /connect_telegram flow — short-circuits routing on match.
      const handledByConnect = await tryHandleConnectFlow({
        text,
        platformId,
        token,
        authorUserId,
      });
      if (handledByConnect) return;

      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      // Pairing matched — record the chat and short-circuit so the
      // code-bearing message never reaches an agent. Privilege is now a
      // property of the paired user, not the chat: upsert the user, and if
      // this instance has no owner yet, promote them to owner.
      const existing = getMessagingGroupByPlatform('telegram', platformId);
      if (existing) {
        updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'telegram',
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          unknown_sender_policy: 'strict',
          created_at: new Date().toISOString(),
        });
      }

      const pairedUserId = `telegram:${consumed.consumed!.adminUserId}`;
      upsertUser({
        id: pairedUserId,
        kind: 'telegram',
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, platformId);
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      // Fail open: pass through so a pairing bug doesn't break normal traffic.
      hostOnInbound(platformId, threadId, message);
    }
  };
}

registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const token = env.TELEGRAM_BOT_TOKEN;
    const telegramAdapter = createTelegramAdapter({
      botToken: token,
      mode: 'polling',
    });
    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext,
      supportsThreads: false,
      transformOutboundText: sanitizeTelegramLegacyMarkdown,
      maxTextLength: 4000,
    });

    const botUsernamePromise = fetchBotUsername(token);

    const wrapped: ChannelAdapter = {
      ...bridge,
      resolveChannelName: async (platformId: string) => {
        const chatId = platformId.split(':').slice(1).join(':');
        if (!chatId) return null;
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId }),
          });
          const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
          return data.ok ? (data.result?.title ?? null) : null;
        } catch {
          return null;
        }
      },
      async setup(hostConfig: ChannelSetup) {
        const intercepted: ChannelSetup = {
          ...hostConfig,
          onInbound: createPairingInterceptor(botUsernamePromise, hostConfig.onInbound, token),
        };
        return withRetry(() => bridge.setup(intercepted), 'bridge.setup');
      },
    };
    return wrapped;
  },
});
