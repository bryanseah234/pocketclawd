/**
 * Clawd — Unified Message Debouncer
 *
 * Per PRD §7.5: collects rapid-fire messages from Telegram + WhatsApp into
 * a single batched prompt for Claude Code, with a 5-second batch window.
 *
 * Cross-platform: messages with the same `sessionId` (per-user) are merged
 * across channels, so a Telegram message and a WhatsApp message sent within
 * 5 seconds reach the agent as ONE prompt.
 *
 * Stickers are silently dropped — zero CPU/memory overhead, no response.
 */

export enum MessageType {
  TEXT = 'text',
  PHOTO = 'photo',
  STICKER = 'sticker', // silently dropped
}

export interface QueuedMessage {
  /** Channel of origin: 'telegram' | 'whatsapp' | ... */
  platform: string;
  /** Message receipt timestamp (ms epoch). */
  timestamp: number;
  /** Platform-native message id, used for dedup/audit. */
  messageId: string;
  /** Plain-text content (caption for photos, body for text). */
  text: string;
  /** Type of message — STICKER messages are dropped on push. */
  messageType: MessageType;
  /** Local file path of the downloaded photo (only for PHOTO type). */
  attachmentPath?: string;
}

/** Default batch window in milliseconds. Override via `BATCH_WINDOW_MS` env var. */
export const DEFAULT_BATCH_WINDOW_MS = 5000;

export type OnBatchCallback = (
  sessionId: string,
  messages: QueuedMessage[],
) => void | Promise<void>;

/**
 * Per-session queue with a sliding 5-second window. New messages reset the
 * timer. When the timer fires, the queued messages are flushed to the
 * `onBatch` callback as a single batch.
 */
export class MessageDebouncer {
  private readonly queues = new Map<string, QueuedMessage[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly onBatch: OnBatchCallback,
    private readonly windowMs: number = DEFAULT_BATCH_WINDOW_MS,
  ) {}

  /**
   * Enqueue a message for the given session. If `message.messageType` is
   * STICKER, the message is silently dropped — no queue mutation, no timer.
   */
  push(sessionId: string, message: QueuedMessage): void {
    if (message.messageType === MessageType.STICKER) {
      // Silent drop — stickers are non-informational, don't waste cycles.
      return;
    }

    const queue = this.queues.get(sessionId) ?? [];
    queue.push(message);
    this.queues.set(sessionId, queue);

    // Reset the timer — every new message extends the window.
    const existingTimer = this.timers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      void this.flush(sessionId);
    }, this.windowMs);

    this.timers.set(sessionId, timer);
  }

  /**
   * Flush a session immediately, bypassing the window. Useful for shutdown.
   *
   * Errors from \`onBatch\` are caught and logged via \`console.error\` —
   * letting them propagate from the timer callback would crash the host
   * process (unhandledRejection). Callers that need to react to failures
   * should pass an \`onBatch\` that handles its own errors.
   *
   * Note: a thrown \`onBatch\` means the batch IS LOST (queue already
   * cleared above). This is intentional: re-queuing risks infinite retry
   * loops on permanent failures (e.g. malformed photo path). Production
   * callers should make \`onBatch\` resilient — wrap in try/catch and write
   * to inbound.db, which itself has WAL/durability guarantees.
   */
  async flush(sessionId: string): Promise<void> {
    const messages = this.queues.get(sessionId);
    this.queues.delete(sessionId);
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);

    if (messages && messages.length > 0) {
      try {
        await this.onBatch(sessionId, messages);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[debouncer] onBatch threw, batch lost', {
          sessionId,
          batchSize: messages.length,
          err,
        });
      }
    }
  }

  /** Flush every active session. Call before process exit. */
  async flushAll(): Promise<void> {
    const sessionIds = Array.from(this.queues.keys());
    await Promise.all(sessionIds.map((id) => this.flush(id)));
  }

  /** Number of active sessions waiting on a timer. */
  size(): number {
    return this.queues.size;
  }
}

/**
 * Render a batch of messages as a structured prompt for Claude Code, per
 * PRD §7.5. Photo messages are tagged with `[PHOTO ATTACHED]`.
 */
export function formatBatchPrompt(messages: QueuedMessage[]): string {
  if (messages.length === 0) {
    return '';
  }

  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  const windowSec = ((last.timestamp - first.timestamp) / 1000).toFixed(1);

  const lines: string[] = [];
  lines.push(`[BATCH START — ${messages.length} messages, ${windowSec}s window]`);

  messages.forEach((m, i) => {
    const time = new Date(m.timestamp).toISOString().slice(11, 19); // HH:MM:SS
    const tag = m.messageType === MessageType.PHOTO ? ' [PHOTO ATTACHED]' : '';
    const body = m.text || (m.messageType === MessageType.PHOTO ? '(no caption)' : '');
    lines.push(`[${i + 1}] [${m.platform} | ${time}]${tag} ${body}`);
  });

  lines.push('[BATCH END]');
  lines.push('');
  lines.push('Instructions: See CLAUDE.md § Batched Message Handling');

  return lines.join('\n');
}
