/**
 * PocketClaw — Chat archival sink.
 *
 * Hooks into the Telegram + WhatsApp channel adapters to capture EVERY
 * inbound message into mnemon, regardless of whether the host routes it to
 * an agent. This is the "everything ingestion" path for chat platforms.
 *
 * PRIVACY WARNING — by design, this stores other people's messages on
 * disk in the user's local mnemon DB. The user has explicitly opted into
 * this. The vault is gitignored and stays on the local machine only, but
 * this is still legally/ethically loaded territory in many jurisdictions.
 *
 * Behaviour:
 *   - Every inbound chat message becomes one mnemon insight tagged
 *     `pocketclaw, src:telegram-chat` (or `whatsapp-chat`)
 *   - Author name + chat name + body get embedded in the content string
 *   - Attachments are noted but NOT downloaded or transcribed (just a
 *     marker like `[image]` or `[audio]` so recall works)
 *   - The hook is fire-and-forget; failures don't block message routing
 *   - Writes serialize through a shared promise chain to avoid SQLITE_BUSY
 *
 * The hook is wired in `src/channels/whatsapp.ts` (messages.upsert) and
 * `src/channels/chat-sdk-bridge.ts` (dispatch path for Telegram + others).
 */

import { spawn } from 'node:child_process';

export type ChatPlatform = 'telegram' | 'whatsapp' | 'discord' | 'slack' | 'matrix' | 'imessage' | 'webex' | 'gchat' | 'teams';

export interface ChatMessageRecord {
  /** Stable platform identifier (`telegram`, `whatsapp`, etc.) — becomes mnemon tag `src:<platform>-chat`. */
  platform: ChatPlatform;
  /** Channel/group/DM identifier on the platform. */
  chatId: string;
  /** Human-readable channel name if known (group title, contact name). Undefined if not yet resolved. */
  chatName?: string;
  /** Whether this is a group chat (vs DM). */
  isGroup: boolean;
  /** Sender's platform identifier (phone JID, telegram user id). */
  senderId: string;
  /** Sender's display name (push name, first_name + last_name). */
  senderName?: string;
  /** Plain-text body. Empty string for media-only messages. */
  text: string;
  /** True if the user themselves sent the message (vs received). */
  fromSelf: boolean;
  /** ISO timestamp (when the underlying platform says the message was sent). */
  occurredAt: Date;
  /** Stable message id on the platform (so re-runs dedup). */
  messageId: string;
  /** Counts of attached media by type. Names not stored; just shape. */
  attachments?: {
    image?: number;
    video?: number;
    audio?: number;
    document?: number;
    sticker?: number;
    voice?: number;
  };
  /** Reply-to message id, if applicable. Helps recall thread context. */
  replyTo?: string;
}

let writeChain: Promise<void> = Promise.resolve();

/**
 * Fire-and-forget chat archival. Returns immediately; the actual mnemon
 * write happens on a serialized promise chain so we never SQLITE_BUSY
 * the local mnemon DB even under message storms (e.g. Baileys's
 * post-pair history-sync flood).
 *
 * Errors are logged to stderr but never thrown. Channel adapters MUST NOT
 * await this — message routing has its own latency budget.
 */
export function archiveChatMessage(record: ChatMessageRecord): void {
  // Filter check: env-var INGEST_CHAT_MODE controls scope.
  // Values: `off` | `self` | `dms` | `all` (default `off` for safety)
  const mode = (process.env.INGEST_CHAT_MODE ?? 'off').toLowerCase();
  if (mode === 'off') return;
  if (mode === 'self' && !record.fromSelf) return;
  if (mode === 'dms' && record.isGroup && !record.fromSelf) return;
  // mode === 'all' or 'dms+self' falls through

  // Skip empty messages and stickers (per PRD §8.5)
  if (!record.text && (!record.attachments || isOnlySticker(record.attachments))) return;

  // Skip if the only content is whitespace
  if (record.text && record.text.trim().length < 2 && !record.attachments) return;

  const next = writeChain.then(
    () => writeMnemon(record),
    () => writeMnemon(record),
  );
  writeChain = next.catch(() => {});
}

function isOnlySticker(att: NonNullable<ChatMessageRecord['attachments']>): boolean {
  const total = (att.image ?? 0) + (att.video ?? 0) + (att.audio ?? 0) + (att.document ?? 0) + (att.voice ?? 0);
  return total === 0 && (att.sticker ?? 0) > 0;
}

function writeMnemon(record: ChatMessageRecord): Promise<void> {
  return new Promise<void>((resolve) => {
    const content = formatContent(record);
    const tags = [
      'pocketclaw',
      `src:${record.platform}-chat`,
      `chat:${truncateForTag(record.chatId)}`,
      record.isGroup ? 'kind:group' : 'kind:dm',
      record.fromSelf ? 'from:self' : 'from:other',
    ];
    if (record.senderId) tags.push(`sender:${truncateForTag(record.senderId)}`);

    const args = [
      'remember',
      content,
      '--source',
      'external',
      '--tags',
      tags.join(','),
      '--no-diff', // chat is high-volume; skip dedup for speed
    ];

    const proc = spawn('mnemon', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    proc.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[chat-ingest] spawn error: ${err.message}`);
      resolve();
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.error(`[chat-ingest] mnemon remember exit ${code}: ${stderr.slice(0, 200)}`);
      }
      resolve();
    });
  });
}

function formatContent(record: ChatMessageRecord): string {
  const chatLabel = record.chatName ?? record.chatId;
  const sender = record.fromSelf ? 'me' : (record.senderName ?? record.senderId);
  const platform = record.platform.charAt(0).toUpperCase() + record.platform.slice(1);
  const kind = record.isGroup ? `group "${chatLabel}"` : (record.chatId === record.senderId ? 'DM' : `chat "${chatLabel}"`);

  let body = record.text || '';
  if (record.attachments) {
    const parts: string[] = [];
    if (record.attachments.image) parts.push(`[${record.attachments.image} image${record.attachments.image > 1 ? 's' : ''}]`);
    if (record.attachments.video) parts.push(`[${record.attachments.video} video${record.attachments.video > 1 ? 's' : ''}]`);
    if (record.attachments.audio) parts.push(`[${record.attachments.audio} audio]`);
    if (record.attachments.voice) parts.push(`[voice note]`);
    if (record.attachments.document) parts.push(`[${record.attachments.document} document${record.attachments.document > 1 ? 's' : ''}]`);
    if (parts.length) body = body ? `${body} ${parts.join(' ')}` : parts.join(' ');
  }

  // Truncate long bodies — mnemon recall returns top N chars anyway, and
  // group floods like meme dumps don't need to be stored verbatim.
  if (body.length > 600) body = body.slice(0, 600) + '...';

  return `${platform} ${kind} — ${sender}: ${body}`;
}

function truncateForTag(value: string): string {
  return value.replace(/[\s,@]/g, '_').slice(0, 60);
}
