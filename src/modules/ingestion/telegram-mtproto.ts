/**
 * PocketClaw — Telegram MTProto runtime ingester.
 *
 * Started at host boot if `${POCKETCLAW_SECRETS_DIR}/telegram_session.txt`
 * exists. Connects to Telegram AS THE USER (not a bot) via GramJS, then:
 *
 *   1. (Optional) Backfills recent message history from every dialog
 *      (controlled by TELEGRAM_BACKFILL_DAYS, default 0 = no backfill).
 *   2. Listens for new messages in real time and pipes them through
 *      `archiveChatMessage()` so they land in mnemon with the same
 *      tagging conventions as the WhatsApp adapter.
 *
 * Like Baileys/WhatsApp, this is an OPT-IN ingestion path:
 *   - Won't start unless TELEGRAM_API_ID / TELEGRAM_API_HASH are set
 *   - Won't archive unless INGEST_CHAT_MODE != 'off'
 *
 * On any unrecoverable error (auth failure, session corruption) we log,
 * cleanup, and stay quiet. The host keeps running for other channels.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { envPath, expandHome } from '../paths.js';
import { archiveChatMessage } from '../chat-archive.js';

let started = false;
let client: TelegramClient | null = null;

function sessionPath(): string {
  if (process.env.TELEGRAM_SESSION_PATH) return expandHome(process.env.TELEGRAM_SESSION_PATH);
  const secretsDir = process.env.POCKETCLAW_SECRETS_DIR
    ? expandHome(process.env.POCKETCLAW_SECRETS_DIR)
    : envPath('POCKETCLAW_SECRETS_DIR', 'secrets');
  return path.join(secretsDir, 'telegram_session.txt');
}

/**
 * Best-effort startup. Fully no-op if creds or session aren't there yet.
 * The Telegram bot's `/connect_telegram` flow writes the session; once
 * it's present, the host's NEXT restart picks it up.
 */
export async function startTelegramMtprotoIngester(): Promise<void> {
  if (started) return;
  started = true;

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) {
    // eslint-disable-next-line no-console
    console.log('[mtproto] TELEGRAM_API_ID/HASH not set — skipping MTProto ingester.');
    return;
  }

  let sessionString = '';
  try {
    sessionString = (await fs.readFile(sessionPath(), 'utf8')).trim();
  } catch {
    // eslint-disable-next-line no-console
    console.log('[mtproto] no saved session yet — DM the bot /connect_telegram first.');
    return;
  }
  if (sessionString.length < 100) {
    // eslint-disable-next-line no-console
    console.log('[mtproto] session file looks empty/dummy — skipping.');
    return;
  }

  client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    baseLogger: new Logger(LogLevel.NONE),
  });

  try {
    await client.connect();
    const me = (await client.getMe()) as Api.User;
    // eslint-disable-next-line no-console
    console.log(`[mtproto] connected as ${me.firstName ?? '?'} ${me.username ? `@${me.username}` : ''} (id=${me.id?.toString()})`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[mtproto] connect failed: ${(err as Error).message}`);
    started = false;
    return;
  }

  // Realtime listener: every incoming message → mnemon.
  client.addEventHandler((event: NewMessageEvent) => {
    void handleNewMessage(event).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[mtproto] handleNewMessage error: ${(err as Error).message}`);
    });
  }, new NewMessage({}));

  // Optional backfill — only if user opted in via env var.
  const backfillDays = Number(process.env.TELEGRAM_BACKFILL_DAYS ?? '0');
  if (backfillDays > 0) {
    void runBackfill(backfillDays).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[mtproto] backfill error: ${(err as Error).message}`);
    });
  }

  // eslint-disable-next-line no-console
  console.log('[mtproto] runtime ingester running.');
}

async function handleNewMessage(event: NewMessageEvent): Promise<void> {
  if (!client) return;
  const msg = event.message;
  if (!msg) return;

  const text = String(msg.message ?? msg.text ?? '');
  if (!text && !msg.media) return; // skip pure-protocol messages

  // Resolve chat + sender via Telegram entity APIs.
  const chat = await msg.getChat().catch(() => null);
  const sender = await msg.getSender().catch(() => null);

  const isGroup = chat ? chat.className !== 'User' : false;
  const chatName: string | undefined = chat
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((chat as any).title ?? (chat as any).firstName ?? undefined)
    : undefined;
  const chatId = chat?.id?.toString() ?? msg.peerId?.toString() ?? 'unknown';

  const senderId = sender?.id?.toString() ?? 'unknown';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const senderObj = sender as any;
  const senderName: string | undefined = sender
    ? (senderObj?.firstName ?? senderObj?.title ?? senderObj?.username ?? undefined)
    : undefined;

  const fromSelf = msg.out === true;

  // Detect attachments
  const attachments: { image?: number; video?: number; audio?: number; document?: number; sticker?: number; voice?: number } = {};
  if (msg.media) {
    const cls = msg.media.className;
    if (cls === 'MessageMediaPhoto') attachments.image = 1;
    else if (cls === 'MessageMediaDocument') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (msg.media as any).document;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mime = doc?.mimeType as string | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const attrs: Array<{ className?: string }> = doc?.attributes ?? [];
      const hasSticker = attrs.some((a) => a.className === 'DocumentAttributeSticker');
      const hasVoice = attrs.some((a) => a.className === 'DocumentAttributeAudio') && mime?.startsWith('audio/');
      const hasVideo = attrs.some((a) => a.className === 'DocumentAttributeVideo') || mime?.startsWith('video/');
      if (hasSticker) attachments.sticker = 1;
      else if (hasVoice) attachments.voice = 1;
      else if (hasVideo) attachments.video = 1;
      else if (mime?.startsWith('image/')) attachments.image = 1;
      else if (mime?.startsWith('audio/')) attachments.audio = 1;
      else attachments.document = 1;
    }
  }

  archiveChatMessage({
    platform: 'telegram',
    chatId,
    chatName,
    isGroup,
    senderId,
    senderName,
    text,
    fromSelf,
    occurredAt: new Date(Number(msg.date) * 1000),
    messageId: `${chatId}:${msg.id}`,
    attachments: Object.keys(attachments).length > 0 ? attachments : undefined,
  });
}

/**
 * Backfill: walk every dialog, pull the last `days` worth of messages,
 * pipe each through chat-archive. Rate-limit to avoid Telegram's flood
 * controls.
 */
async function runBackfill(days: number): Promise<void> {
  if (!client) return;
  const since = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
  // eslint-disable-next-line no-console
  console.log(`[mtproto] backfill starting — window ${days} day(s)`);

  let total = 0;
  for await (const dialog of client.iterDialogs({ limit: 200 })) {
    try {
      const entity = dialog.entity;
      if (!entity) continue;
      const isGroup = dialog.isChannel || dialog.isGroup;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ent = entity as any;
      const chatName: string | undefined = ent.title ?? ent.firstName ?? ent.username;
      const chatId = entity.id?.toString() ?? 'unknown';

      let count = 0;
      for await (const msg of client.iterMessages(entity, { limit: 500 })) {
        if (!msg) continue;
        const ts = Number(msg.date);
        if (ts < since) break;
        const text = String(msg.message ?? '');
        if (!text && !msg.media) continue;

        const sender = await msg.getSender().catch(() => null);
        const senderId = sender?.id?.toString() ?? 'unknown';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const senderObj = sender as any;
        const senderName: string | undefined = sender
          ? (senderObj?.firstName ?? senderObj?.title ?? senderObj?.username ?? undefined)
          : undefined;
        const fromSelf = msg.out === true;

        archiveChatMessage({
          platform: 'telegram',
          chatId,
          chatName,
          isGroup: Boolean(isGroup),
          senderId,
          senderName,
          text,
          fromSelf,
          occurredAt: new Date(ts * 1000),
          messageId: `${chatId}:${msg.id}`,
        });
        count += 1;
      }
      if (count > 0) {
        // eslint-disable-next-line no-console
        console.log(`[mtproto] backfill ${chatName ?? chatId}: ${count} messages`);
        total += count;
      }
      // Gentle rate limit — Telegram tolerates ~30 req/sec but we don't need to push it.
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[mtproto] dialog backfill error: ${(err as Error).message}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[mtproto] backfill complete — total ${total} messages archived`);
}

/** Graceful shutdown for tests + restart paths. */
export async function stopTelegramMtprotoIngester(): Promise<void> {
  if (client) {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
    client = null;
  }
  started = false;
}
