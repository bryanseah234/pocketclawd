/**
 * Cloud-mode WhatsApp responder.
 *
 * Wires inbound DM messages to Bedrock Claude and ships the reply back through
 * the WhatsApp adapter. This is the minimal direct path — no v2 host router,
 * no per-user containers. Sliding-window in-memory history per chat (last
 * 20 turns), persisted to DynamoDB nanoclaw-chat-messages for the dashboard.
 *
 * Activation: requires AWS env (DATA_BUCKET present). When v2 routing finds no
 * agent groups, control falls through to this responder.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import type { ChannelAdapter, InboundMessage } from './channels/adapter.js';
import { logger } from './modules/logger.js';

const log = logger.child({ component: 'cloud-responder' });

const REGION = process.env.AWS_REGION ?? 'ap-southeast-1';
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'apac.anthropic.claude-sonnet-4-5-20250929-v1:0';
const MESSAGES_TABLE = process.env.MESSAGES_TABLE ?? 'nanoclaw-chat-messages';
const HISTORY_LIMIT = 20; // last 20 turns

const bedrock = new BedrockRuntimeClient({ region: REGION });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

const histories = new Map<string, Turn[]>();

const SYSTEM_PROMPT = `You are Clawd, a friendly personal AI assistant chatting with the user on WhatsApp.

Style:
- Warm, concise, conversational. Match the user's energy.
- WhatsApp-native formatting: *bold* and _italic_ only — never ** or __.
- Short replies by default. One paragraph, two max.
- No filler ("Sure!", "Of course!", "I'd be happy to help!"). Get to the point.
- Use first-name basis. Singapore-friendly (lah/leh/sia OK if user uses them, otherwise neutral).

Capabilities:
- You remember the conversation in this chat.
- You can answer questions, help organize thoughts, summarize info, or just chat.
- If a request needs document/calendar/email integration that isn't wired up yet, say so plainly.

Personality: warm, witty, never sycophantic. You are NOT a customer service bot.`;

/**
 * Process an inbound DM and respond via Bedrock.
 */
export async function respondToDM(
  adapter: ChannelAdapter,
  platformId: string,
  message: InboundMessage,
): Promise<void> {
  // Only text messages — skip media-only
  const content = (message.content as Record<string, unknown>) ?? {};
  const text = (content.text as string) || (content.caption as string) || '';
  if (!text.trim()) {
    log.debug('Skipping empty/media-only message', { platformId });
    return;
  }

  const sender = (content.sender as string) ?? platformId;

  // Append to history
  const history = histories.get(platformId) ?? [];
  history.push({ role: 'user', content: text });

  // Persist user message
  fireAndForget(persistMessage(sender, platformId, message.id, 'user', text, message.timestamp));

  // Build Bedrock messages array (last N turns)
  const turns = history.slice(-HISTORY_LIMIT);

  try {
    const startedAt = Date.now();
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: turns.map((t) => ({ role: t.role, content: t.content })),
    });

    const cmd = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });
    const r = await bedrock.send(cmd);
    const decoded = JSON.parse(new TextDecoder().decode(r.body));
    const reply = (decoded.content?.[0]?.text as string)?.trim();

    if (!reply) {
      log.warn('Bedrock returned empty reply', { platformId, decoded });
      return;
    }

    log.info('Bedrock reply', {
      platformId,
      ms: Date.now() - startedAt,
      inputTokens: decoded.usage?.input_tokens,
      outputTokens: decoded.usage?.output_tokens,
      replyLen: reply.length,
    });

    history.push({ role: 'assistant', content: reply });
    histories.set(platformId, history.slice(-HISTORY_LIMIT));

    // Send via WA adapter
    await adapter.deliver(platformId, null, {
      content: { text: reply, markdown: reply },
    });

    fireAndForget(persistMessage(sender, platformId, undefined, 'assistant', reply, new Date().toISOString()));
  } catch (err) {
    log.error('Bedrock responder failed', {
      platformId,
      err: err instanceof Error ? { message: err.message, name: err.name } : String(err),
    });
    // Send a graceful fallback so the user knows something happened
    try {
      await adapter.deliver(platformId, null, {
        content: {
          text: "Sorry, I hit a snag on my end. Try again in a sec.",
          markdown: "Sorry, I hit a snag on my end. Try again in a sec.",
        },
      });
    } catch {
      // swallow
    }
  }
}

async function persistMessage(
  userId: string,
  chatJid: string,
  messageId: string | undefined,
  role: 'user' | 'assistant',
  text: string,
  timestamp: string,
): Promise<void> {
  await dynamo.send(
    new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: {
        userId,
        timestamp,
        chatJid,
        messageId: messageId ?? `out-${Date.now()}`,
        role,
        text,
        ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
      },
    }),
  );
}

function fireAndForget<T>(p: Promise<T>): void {
  p.catch((err) => log.warn('Background persist failed', { err: err instanceof Error ? err.message : String(err) }));
}

/**
 * Test-only: clear in-memory history.
 */
export function _resetHistories(): void {
  histories.clear();
}
