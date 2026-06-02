/**
 * WhatsApp channel adapter (v2) — native Baileys v7 implementation.
 *
 * Implements ChannelAdapter directly (no Chat SDK bridge) using
 * @whiskeysockets/baileys 7.0.0-rc.9 (pinned — last release, unmaintained).
 * Ports proven v1 infrastructure: getMessage fallback, outgoing queue,
 * group metadata cache, LID mapping, reconnection with backoff.
 *
 * LID handling: Baileys v7 provides participantAlt / remoteJidAlt on every
 * inbound message via extractAddressingContext, plus a real
 * signalRepository.lidMapping.getPNForLID API. The adapter always resolves
 * to phone JID (@s.whatsapp.net) before emitting to the router.
 *
 * Auth credentials persist in store/auth/. On first run:
 * - If WHATSAPP_PHONE_NUMBER is set → pairing code (printed to log)
 * - Otherwise → QR code (printed to log)
 * Subsequent restarts reuse the saved session automatically.
 */
import fs from 'fs';
import path from 'path';
// Named import (not default) — pino's .d.ts under NodeNext resolution
// exports `{ pino as default, pino }`, but the namespace/function merge at
// `declare namespace pino` + `declare function pino` makes the default
// resolve to `typeof pino` (the namespace type), which isn't callable.
// The named export resolves to the callable function.
import { pino } from 'pino';

import {
  makeWASocket,
  proto,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { GroupMetadata, WAMessageKey, WAMessage, WASocket } from '@whiskeysockets/baileys';

import { isSafeAttachmentName } from '../attachment-safety.js';
import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { envPath } from '../modules/paths.js';

/**
 * Aliases the user can prefix when summoning the bot from their own number.
 * Comma-separated, case-insensitive, matched at start of trimmed message content.
 * Default '@clawd' — extend via WHATSAPP_OWNER_ALIASES env var.
 * Only meaningful when ASSISTANT_HAS_OWN_NUMBER=false (single-number setup).
 */
const OWNER_ALIASES: string[] = (process.env.WHATSAPP_OWNER_ALIASES || '@clawd')
  .split(',')
  .map((a) => a.trim().toLowerCase())
  .filter((a) => a.length > 0);
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import type { ChannelAdapter, ChannelSetup, ConversationInfo, InboundMessage, OutboundMessage } from './adapter.js';
import { WhatsAppSessionBackup } from '../modules/whatsapp-session-backup.js';

const baileysLogger = pino({ level: 'silent' });

/**
 * Fetch the latest WhatsApp Web version. Baileys' built-in
 * fetchLatestWaWebVersion scrapes sw.js which is aggressively
 * rate-limited (429). When it fails, Baileys falls back to a
 * hardcoded version that goes stale within weeks — WhatsApp
 * rejects connections with an expired buildHash (405 at Noise
 * layer). This fetches from wppconnect's version tracker as a
 * more reliable source, with Baileys' own fetch as fallback.
 */
async function resolveWaWebVersion(): Promise<[number, number, number]> {
  // 1. Try wppconnect version tracker (HTML scrape — no JSON API)
  try {
    const res = await fetch('https://wppconnect.io/whatsapp-versions/', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/2\.3000\.(\d+)/);
      if (match) {
        const version: [number, number, number] = [2, 3000, Number(match[1])];
        log.info('Fetched WA Web version from wppconnect', { version });
        return version;
      }
    }
  } catch {
    // Fall through to Baileys' own fetch
  }

  // 2. Try Baileys' built-in fetch (scrapes sw.js — often 429'd)
  try {
    const { version } = await fetchLatestWaWebVersion({});
    if (version) {
      log.info('Fetched WA Web version from Baileys', { version });
      return version as [number, number, number];
    }
  } catch {
    // Fall through
  }

  throw new Error(
    'Could not fetch current WhatsApp Web version from any source. ' +
    'Baileys hardcodes a stale version that WhatsApp rejects (405). ' +
    'Check network connectivity to wppconnect.io and web.whatsapp.com.',
  );
}

const AUTH_DIR = envPath('WHATSAPP_AUTH_DIR', 'whatsapp');
const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const GROUP_METADATA_CACHE_TTL_MS = 60_000; // 1 min for outbound sends
const SENT_MESSAGE_CACHE_MAX = 256;
const RECONNECT_DELAY_MS = 5000;
const SESSION_BACKUP_INTERVAL_MS = 5 * 60 * 1000;   // backup every 5 min
const KEEPALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000;   // self-DM every 6h to keep Baileys alive
const SESSION_S3_PREFIX = 'whatsapp-session/';
const PENDING_QUESTIONS_MAX = 64;
const MAX_OUTGOING_QUEUE = 500;

/** Normalize an option label to a slash command: "Approve" → "/approve" */
function optionToCommand(option: string): string {
  return '/' + option.toLowerCase().replace(/\s+/g, '-');
}

// --- Markdown → WhatsApp formatting ---

interface TextSegment {
  content: string;
  isProtected: boolean;
}

/** Split text into code-block-protected and unprotected regions. */
function splitProtectedRegions(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const codeBlockRegex = /```[\s\S]*?```|`[^`\n]+`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ content: text.slice(lastIndex, match.index), isProtected: false });
    }
    segments.push({ content: match[0], isProtected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), isProtected: false });
  }

  return segments;
}

/** Apply WhatsApp-native formatting to an unprotected text segment. */
function transformForWhatsApp(text: string): string {
  // Order matters: italic before bold to avoid **bold** → *bold* → _bold_
  // 1. Italic: *text* (not **) → _text_
  text = text.replace(/(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '_$1_');
  // 2. Bold: **text** → *text*
  text = text.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '*$1*');
  // 3. Headings: ## Title → *Title*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // 4. Links: [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // 5. Horizontal rules: --- / *** / ___ → stripped
  text = text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');
  return text;
}

/** Convert Claude's markdown to WhatsApp-native formatting. */
function formatWhatsApp(text: string): string {
  const segments = splitProtectedRegions(text);
  return segments.map(({ content, isProtected }) => (isProtected ? content : transformForWhatsApp(content))).join('');
}

/**
 * Subset of a normalized Baileys message content carrying the message
 * types that can host a `contextInfo.mentionedJid` array. Kept as a
 * structural type so the helper (and its tests) don't pull in the full
 * `proto.IMessage` shape just to construct fixtures.
 */
type MentionContextSource = {
  extendedTextMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
  imageMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
  videoMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
  documentMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
};

/**
 * Detect an explicit @-mention of the bot in a WhatsApp group message.
 * WhatsApp carries mentions in `contextInfo.mentionedJid` on the text +
 * caption-bearing message types. Matches against both the bot's phone
 * JID and LID — most modern clients emit the LID even when the human
 * typed a phone-number mention.
 *
 * Exported for unit testing. The inbound construction site calls this
 * to set `InboundMessage.isMention` for group messages (#2560). DMs are
 * unconditionally mentions and don't go through this helper.
 */
export function isBotMentionedInGroup(
  normalized: MentionContextSource,
  botPhoneJid: string | undefined,
  botLidUser: string | undefined,
): boolean {
  if (!botPhoneJid && !botLidUser) return false;
  const mentionedJids: string[] = [
    ...(normalized.extendedTextMessage?.contextInfo?.mentionedJid ?? []),
    ...(normalized.imageMessage?.contextInfo?.mentionedJid ?? []),
    ...(normalized.videoMessage?.contextInfo?.mentionedJid ?? []),
    ...(normalized.documentMessage?.contextInfo?.mentionedJid ?? []),
  ];
  const botLidJid = botLidUser ? `${botLidUser}@lid` : undefined;
  return mentionedJids.some((jid) => {
    if (!jid) return false;
    const bare = jid.split(':')[0];
    return bare === botPhoneJid || bare === botLidJid;
  });
}

/**
 * Compute `InboundMessage.isMention` for a WhatsApp message:
 *   - DMs are always mentions (router auto-engages on the bot's behalf).
 *   - Group messages are mentions only when the bot is explicitly tagged.
 *
 * Returns `true | undefined` rather than `true | false` because the
 * `InboundMessage` field is `isMention?: boolean` and downstream code
 * treats `undefined` differently than an explicit `false` (#2560).
 */
export function computeIsMention(isGroup: boolean, botMentionedInGroup: boolean): true | undefined {
  if (!isGroup) return true;
  return botMentionedInGroup ? true : undefined;
}

/** Map file extension to Baileys media message type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMediaMessage(data: Buffer, filename: string, ext: string, caption?: string): any {
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv'];
  const audioExts = ['.mp3', '.ogg', '.m4a', '.wav', '.aac', '.opus'];

  if (imageExts.includes(ext)) {
    return { image: data, caption, mimetype: `image/${ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1)}` };
  }
  if (videoExts.includes(ext)) {
    return { video: data, caption, mimetype: `video/${ext.slice(1)}` };
  }
  if (audioExts.includes(ext)) {
    return { audio: data, mimetype: `audio/${ext.slice(1) === 'mp3' ? 'mpeg' : ext.slice(1)}` };
  }
  // Default: send as document
  return { document: data, fileName: filename, caption, mimetype: 'application/octet-stream' };
}

registerChannelAdapter('whatsapp', {
  factory: async () => {
    const env = readEnvFile(['WHATSAPP_PHONE_NUMBER', 'WHATSAPP_ENABLED']);
    const phoneNumber = env.WHATSAPP_PHONE_NUMBER;
    const authDir = AUTH_DIR;

    // Bail BEFORE touching the filesystem if WhatsApp is explicitly disabled.
    // Touching authDir before this check causes EACCES in non-root smoke
    // containers where authDir falls back to ~/.clawd/whatsapp (the
    // nanoclaw user's home is /home/nanoclaw and is not writable).
    if (!env.WHATSAPP_ENABLED && !phoneNumber) {
      // We could still try fs.existsSync as the original code did, but only
      // if authDir is something we can safely access. In smoke containers
      // authDir is /home/nanoclaw/.clawd/whatsapp which doesn't exist, and
      // fs.existsSync returns false there without throwing — so this is safe.
      try {
        if (!fs.existsSync(path.join(authDir, 'creds.json'))) return null;
      } catch {
        return null;
      }
    }

    // ── Session backup (S3) — survives container restarts ──
    const dataBucket = process.env.DATA_BUCKET || '';
    const awsRegion = process.env.AWS_REGION || 'ap-southeast-1';
    const sessionBackup = dataBucket
      ? new WhatsAppSessionBackup({
          s3Bucket: dataBucket,
          s3Prefix: SESSION_S3_PREFIX,
          localAuthDir: authDir,
          region: awsRegion,
        })
      : null;
    let backupTimer: NodeJS.Timeout | null = null;
    let keepaliveTimer: NodeJS.Timeout | null = null;
    let lastBackupAt = 0;
    const debouncedBackup = (delayMs = 2000) => {
      if (!sessionBackup) return;
      if (backupTimer) return;  // already scheduled
      backupTimer = setTimeout(async () => {
        backupTimer = null;
        try {
          const r = await sessionBackup.backup();
          lastBackupAt = Date.now();
          if (r.errors.length > 0) {
            log.warn('WA session backup completed with errors', { uploaded: r.uploaded.length, errors: r.errors.slice(0, 3) });
          } else {
            log.debug('WA session backed up to S3', { files: r.uploaded.length });
          }
        } catch (err) {
          log.warn('WA session backup failed', { err: err instanceof Error ? err.message : String(err) });
        }
      }, delayMs);
    };

    // Now safe to mkdir — we are committed to running the WA adapter.
    try {
      fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    } catch (mkdirErr) {
      log.error('WA adapter: failed to create auth dir, disabling channel', {
        authDir,
        err: mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr),
      });
      return null;
    }
    let hasAuth = fs.existsSync(path.join(authDir, 'creds.json'));

    // Restore from S3 if local is empty
    if (!hasAuth && sessionBackup) {
      try {
        const r = await sessionBackup.restore();
        if (r.restored.length > 0) {
          log.info('WA session restored from S3', { files: r.restored.length });
          hasAuth = fs.existsSync(path.join(authDir, 'creds.json'));
        }
      } catch (err) {
        log.warn('WA session restore from S3 failed (continuing with empty session)', { err: err instanceof Error ? err.message : String(err) });
      }
    }

    if (!hasAuth && !phoneNumber && !env.WHATSAPP_ENABLED) return null;

    // State
    let sock: WASocket;
    let connected = false;
    let setupConfig: ChannelSetup;

    // LID → phone JID mapping (WhatsApp's new ID system)
    const lidToPhoneMap: Record<string, string> = {};
    let botLidUser: string | undefined;
    let botPhoneJid: string | undefined;

    // Outgoing queue for messages sent while disconnected
    const outgoingQueue: Array<{ jid: string; text: string }> = [];
    let flushing = false;

    // Sent message cache for retry/re-encrypt requests
    const sentMessageCache = new Map<string, any>();

    // Group metadata cache with TTL
    const groupMetadataCache = new Map<string, { metadata: GroupMetadata; expiresAt: number }>();

    // Pending questions: chatJid → { questionId, options }
    // User replies with /approve, /reject, etc. to answer
    const pendingQuestions = new Map<
      string,
      {
        questionId: string;
        options: NormalizedOption[];
      }
    >();

    // Group sync tracking
    let lastGroupSync = 0;
    let groupSyncTimerStarted = false;

    // First-connect promise
    let resolveFirstOpen: (() => void) | undefined;
    let rejectFirstOpen: ((err: Error) => void) | undefined;

    // Pairing code file for the setup skill to poll
    const pairingCodeFile = path.join(process.cwd(), 'store', 'pairing-code.txt');

    // --- Helpers ---

    function setLidPhoneMapping(lidUser: string, phoneJid: string): void {
      if (lidToPhoneMap[lidUser] === phoneJid) return;
      lidToPhoneMap[lidUser] = phoneJid;
      // Cached group metadata depends on participant IDs — invalidate
      groupMetadataCache.clear();
    }

    async function translateJid(jid: string, altJid?: string): Promise<string> {
      if (!jid.endsWith('@lid')) return jid;
      const lidUser = jid.split('@')[0].split(':')[0];

      // 1. Check local cache
      const cached = lidToPhoneMap[lidUser];
      if (cached) return cached;

      // 2. Use the alt JID from extractAddressingContext (v7 provides this
      //    on every inbound message as remoteJidAlt / participantAlt)
      if (altJid && !altJid.endsWith('@lid')) {
        const phoneJid = altJid.includes('@') ? altJid : `${altJid}@s.whatsapp.net`;
        setLidPhoneMapping(lidUser, phoneJid);
        log.info('Translated LID via alt JID', { lidJid: jid, phoneJid });
        return phoneJid;
      }

      // 3. Query Baileys v7 LID mapping store
      try {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
        if (pn) {
          const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
          setLidPhoneMapping(lidUser, phoneJid);
          log.info('Translated LID via signal repository', { lidJid: jid, phoneJid });
          return phoneJid;
        }
      } catch (err) {
        log.debug('Failed to resolve LID via signalRepository', { jid, err });
      }

      return jid;
    }

    async function getNormalizedGroupMetadata(jid: string): Promise<GroupMetadata | undefined> {
      if (!jid.endsWith('@g.us')) return undefined;

      const cached = groupMetadataCache.get(jid);
      if (cached && cached.expiresAt > Date.now()) return cached.metadata;

      const metadata = await sock.groupMetadata(jid);
      const participants = await Promise.all(
        metadata.participants.map(async (p) => ({
          ...p,
          id: await translateJid(p.id),
        })),
      );
      const normalized = { ...metadata, participants };
      groupMetadataCache.set(jid, {
        metadata: normalized,
        expiresAt: Date.now() + GROUP_METADATA_CACHE_TTL_MS,
      });
      return normalized;
    }

    async function syncGroupMetadata(force = false): Promise<void> {
      if (!force && lastGroupSync && Date.now() - lastGroupSync < GROUP_SYNC_INTERVAL_MS) {
        return;
      }
      try {
        log.info('Syncing group metadata from WhatsApp...');
        const groups = await sock.groupFetchAllParticipating();
        let count = 0;
        for (const [jid, metadata] of Object.entries(groups)) {
          if (metadata.subject) {
            setupConfig.onMetadata(jid, metadata.subject, true);
            count++;
          }
        }
        lastGroupSync = Date.now();
        log.info('Group metadata synced', { count });
      } catch (err) {
        log.error('Failed to sync group metadata', { err });
      }
    }

    async function flushOutgoingQueue(): Promise<void> {
      if (flushing || outgoingQueue.length === 0) return;
      flushing = true;
      try {
        log.info('Flushing outgoing message queue', { count: outgoingQueue.length });
        while (outgoingQueue.length > 0) {
          const item = outgoingQueue.shift()!;
          try {
            const sent = await sock.sendMessage(item.jid, { text: item.text });
            if (sent?.key?.id && sent.message) {
              sentMessageCache.set(sent.key.id, sent.message);
            }
          } catch (err) {
            // Re-queue at the head and stop flushing; subsequent messages
            // will likely fail too against a still-broken connection.
            // The connection.update 'open' handler retriggers flush on
            // reconnect.
            outgoingQueue.unshift(item);
            log.warn('Flush failed mid-queue, re-queued and stopping', {
              jid: item.jid,
              err,
              remaining: outgoingQueue.length,
            });
            break;
          }
        }
      } finally {
        flushing = false;
      }
    }

    /** Download media from an inbound message, save to /workspace/attachments/. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function downloadInboundMedia(
      msg: WAMessage,
      normalized: any,
    ): Promise<Array<{ type: string; name: string; localPath: string }>> {
      const mediaTypes: Array<{ key: string; type: string; ext: string }> = [
        { key: 'imageMessage', type: 'image', ext: '.jpg' },
        { key: 'videoMessage', type: 'video', ext: '.mp4' },
        { key: 'audioMessage', type: 'audio', ext: '.ogg' },
        { key: 'documentMessage', type: 'document', ext: '' },
      ];
      const results: Array<{ type: string; name: string; localPath: string }> = [];
      for (const { key, type, ext } of mediaTypes) {
        if (!normalized[key]) continue;
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          // documentMessage.fileName is attacker-controlled and rides through
          // WhatsApp's E2E channel — Meta can't sanitize it server-side. Without
          // this guard, a `..`-laden fileName escapes attachDir on path.join.
          const rawFilename = normalized[key].fileName;
          const fallback = `${type}-${Date.now()}${ext}`;
          const filename = isSafeAttachmentName(rawFilename) ? rawFilename : fallback;
          if (rawFilename && filename !== rawFilename) {
            log.warn('Refused unsafe attachment filename — would escape attachments dir', {
              rawFilename,
              replacement: filename,
            });
          }
          const attachDir = path.join(DATA_DIR, 'attachments');
          fs.mkdirSync(attachDir, { recursive: true });
          // Prefix with WA message id to prevent collisions: two messages
          // with the same fileName ('image.jpg', 'photo.jpg' from camera)
          // would otherwise overwrite each other.
          const msgId = msg.key.id ? msg.key.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) : `wa-${Date.now()}`;
          const uniqueFilename = `${msgId}-${filename}`;
          const filePath = path.join(attachDir, uniqueFilename);
          fs.writeFileSync(filePath, buffer);
          results.push({ type, name: filename, localPath: `attachments/${uniqueFilename}` });
          log.info('Media downloaded', { type, filename: uniqueFilename });
        } catch (err) {
          log.warn('Failed to download media', { type, err });
        }
      }
      return results;
    }

    async function sendRawMessage(jid: string, text: string): Promise<string | undefined> {
      if (!connected) {
        if (outgoingQueue.length >= MAX_OUTGOING_QUEUE) {
          // Shed oldest to keep memory bounded during long disconnects.
          const dropped = outgoingQueue.shift();
          log.warn('WA outgoing queue full, dropping oldest', {
            droppedJid: dropped?.jid,
            queueSize: outgoingQueue.length,
          });
        }
        outgoingQueue.push({ jid, text });
        log.info('WA disconnected, message queued', { jid, queueSize: outgoingQueue.length });
        return;
      }
      try {
        const sent = await sock.sendMessage(jid, { text });
        if (sent?.key?.id && sent.message) {
          sentMessageCache.set(sent.key.id, sent.message);
          if (sentMessageCache.size > SENT_MESSAGE_CACHE_MAX) {
            const oldest = sentMessageCache.keys().next().value!;
            sentMessageCache.delete(oldest);
          }
        }
        return sent?.key?.id ?? undefined;
      } catch (err) {
        if (outgoingQueue.length >= MAX_OUTGOING_QUEUE) {
          const dropped = outgoingQueue.shift();
          log.warn('WA outgoing queue full, dropping oldest', {
            droppedJid: dropped?.jid,
            queueSize: outgoingQueue.length,
          });
        }
        outgoingQueue.push({ jid, text });
        log.warn('Failed to send, message queued', { jid, err, queueSize: outgoingQueue.length });
        return undefined;
      }
    }

    // --- Socket creation ---

    async function connectSocket(): Promise<void> {
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      const version = await resolveWaWebVersion();

      sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        printQRInTerminal: false,
        logger: baileysLogger,
        browser: Browsers.macOS('Chrome'),
        cachedGroupMetadata: async (jid: string) => getNormalizedGroupMetadata(jid),
        getMessage: async (key: WAMessageKey) => {
          // Check in-memory cache first (recently sent messages)
          const cached = sentMessageCache.get(key.id || '');
          if (cached) return cached;
          // Return empty message to prevent indefinite "waiting for this message"
          return proto.Message.create({});
        },
      });

      // Request pairing code if phone number is set and not yet registered
      if (phoneNumber && !state.creds.registered) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(phoneNumber);
            log.info(`WhatsApp pairing code: ${code}`);
            log.info('Enter in WhatsApp > Linked Devices > Link with phone number');
            fs.writeFileSync(pairingCodeFile, code, 'utf-8');
          } catch (err) {
            log.error('Failed to request pairing code', { err });
          }
        }, 3000);
      }

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !phoneNumber) {
          // QR code auth — print to terminal + push to admin dashboard bridge
          (async () => {
            try {
              const QRCode = await import('qrcode');
              const qrText = await QRCode.toString(qr, { type: 'terminal' });
              log.info('WhatsApp QR code — scan with WhatsApp > Linked Devices:\n' + qrText);
            } catch {
              log.info('WhatsApp QR code (raw)', { qr });
            }
            // Push QR to admin dashboard bridge (if available in cloud mode)
            try {
              const bridge = (globalThis as any).__nanoclaw_wa_bridge;
              if (bridge?.setQrCode) await bridge.setQrCode(qr);
            } catch { /* bridge not available */ }
          })();
        }

        if (connection === 'close') {
          connected = false;
          // Notify admin dashboard bridge
          try {
            const bridge = (globalThis as any).__nanoclaw_wa_bridge;
            if (bridge?.setWhatsAppDisconnected) bridge.setWhatsAppDisconnected();
          } catch { /* bridge not available */ }
          const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          const shouldReconnect = reason !== DisconnectReason.loggedOut;

          log.info('WhatsApp connection closed', { reason, shouldReconnect });

          if (shouldReconnect) {
            log.info('Reconnecting...');
            connectSocket().catch((err) => {
              log.error('Failed to reconnect, retrying in 5s', { err });
              setTimeout(() => {
                connectSocket().catch((err2) => {
                  log.error('Reconnection retry failed', { err: err2 });
                });
              }, RECONNECT_DELAY_MS);
            });
          } else {
            log.info('WhatsApp logged out');
            if (rejectFirstOpen) {
              rejectFirstOpen(new Error('WhatsApp logged out'));
              rejectFirstOpen = undefined;
              resolveFirstOpen = undefined;
            }
          }
        } else if (connection === 'open') {
          connected = true;
          log.info('Connected to WhatsApp');

          // Initial backup right after connection (creds may have just changed)
          debouncedBackup(5000);

          // Periodic backup every 5 minutes
          if (!backupTimer && sessionBackup) {
            const periodicBackup = setInterval(() => {
              if (Date.now() - lastBackupAt >= SESSION_BACKUP_INTERVAL_MS - 1000) {
                debouncedBackup(0);
              }
            }, SESSION_BACKUP_INTERVAL_MS);
            (periodicBackup as unknown as { unref?: () => void }).unref?.();
          }

          // 6-hour self-DM keep-alive (prevents Baileys timeout on idle accounts)
          if (keepaliveTimer) clearInterval(keepaliveTimer);
          keepaliveTimer = setInterval(async () => {
            try {
              const myJid = sock.user?.id;
              if (!myJid) return;
              const phoneJid = myJid.split(':')[0] + '@s.whatsapp.net';
              await sock.sendMessage(phoneJid, { text: `🔄 Keepalive ${new Date().toISOString()}` });
              log.debug('WA keep-alive self-DM sent');
            } catch (err) {
              log.warn('WA keep-alive self-DM failed', { err: err instanceof Error ? err.message : String(err) });
            }
          }, KEEPALIVE_INTERVAL_MS);
          (keepaliveTimer as unknown as { unref?: () => void }).unref?.();
          // Notify admin dashboard bridge
          try {
            const bridge = (globalThis as any).__nanoclaw_wa_bridge;
            if (bridge?.setWhatsAppConnected) bridge.setWhatsAppConnected(sock.user?.id || 'unknown');
          } catch { /* bridge not available */ }

          // Clean up pairing code file after successful connection
          try {
            if (fs.existsSync(pairingCodeFile)) fs.unlinkSync(pairingCodeFile);
          } catch {
            /* ignore */
          }

          // Announce availability for presence updates
          sock.sendPresenceUpdate('available').catch((err) => {
            log.warn('Failed to send presence update', { err });
          });

          // Build LID → phone mapping from auth state
          if (sock.user) {
            const phoneUser = sock.user.id.split(':')[0];
            const lidUser = sock.user.lid?.split(':')[0];
            botPhoneJid = `${phoneUser}@s.whatsapp.net`;
            if (lidUser && phoneUser) {
              setLidPhoneMapping(lidUser, botPhoneJid);
              botLidUser = lidUser;
            }
          }

          // Flush queued messages
          flushOutgoingQueue().catch((err) => log.error('Failed to flush outgoing queue', { err }));

          // Group sync
          syncGroupMetadata().catch((err) => log.error('Initial group sync failed', { err }));
          if (!groupSyncTimerStarted) {
            groupSyncTimerStarted = true;
            setInterval(() => {
              syncGroupMetadata().catch((err) => log.error('Periodic group sync failed', { err }));
            }, GROUP_SYNC_INTERVAL_MS);
          }

          // Signal first open
          if (resolveFirstOpen) {
            resolveFirstOpen();
            resolveFirstOpen = undefined;
            rejectFirstOpen = undefined;
          }
        }
      });

      sock.ev.on('creds.update', async () => {
        await saveCreds();
        debouncedBackup();
      });

      // LID ↔ phone mapping updates (v7 replaces chats.phoneNumberShare)
      sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
        const lidUser = lid?.split('@')[0].split(':')[0];
        if (lidUser && pn) {
          const phoneJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
          setLidPhoneMapping(lidUser, phoneJid);
        }
      });

      // Inbound messages
      sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
          try {
            if (!msg.message) continue;
            const normalized = normalizeMessageContent(msg.message);
            if (!normalized) continue;
            const rawJid = msg.key.remoteJid;
            if (!rawJid || rawJid === 'status@broadcast') continue;

            // Translate LID → phone JID using v7's alt JID from extractAddressingContext
            const chatJid = await translateJid(rawJid, msg.key.remoteJidAlt);

            const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
            const isGroup = chatJid.endsWith('@g.us');

            // ── STRICT DM-ONLY ALLOWLIST ──
            // Clawd is a personal 1:1 DM assistant. ONLY `@s.whatsapp.net` JIDs
            // are processed. Everything else is silently dropped before metadata/
            // upload/dispatch:
            //   @g.us              groups
            //   @newsletter        WhatsApp Channels (newsletters)
            //   @broadcast         broadcast lists
            //   status@broadcast   status updates
            //   @lid               linked-device pseudo-jids
            //   @c.us              legacy contact format
            const isPersonalDm = chatJid.endsWith('@s.whatsapp.net');
            if (!isPersonalDm) {
              continue;
            }

            // Notify metadata for group discovery
            setupConfig.onMetadata(chatJid, undefined, isGroup);

            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // Extract quoted/reply context -- prepend to content so LLM has thread context
            const _qMsg = normalized.extendedTextMessage?.contextInfo?.quotedMessage;
            if (_qMsg) {
              const _qText: string =
                ((_qMsg as Record<string,unknown>).conversation as string) ||
                (((_qMsg as Record<string,unknown>).extendedTextMessage as Record<string,unknown>|undefined)?.text as string) ||
                (((_qMsg as Record<string,unknown>).imageMessage as Record<string,unknown>|undefined)?.caption as string) ||
                '';
              if (_qText && content) {
                content = '[Replying to: "' + _qText.slice(0, 300) + (_qText.length > 300 ? '...' : '') + '"]\n' + content;
              }
            }

            // Normalize bot LID mention → assistant name for trigger matching
            if (botLidUser && content.includes(`@${botLidUser}`)) {
              content = content.replace(`@${botLidUser}`, `@${ASSISTANT_NAME}`);
            }

            // Download media attachments (images, video, audio, documents)
            const attachments = await downloadInboundMedia(msg, normalized);

            // Skip empty protocol messages (no text and no attachments)
            if (!content && attachments.length === 0) continue;

            // Resolve sender: in groups, participant may be LID — use participantAlt
            const rawSender = msg.key.participant || msg.key.remoteJid || '';
            const sender = rawSender.endsWith('@lid')
              ? await translateJid(rawSender, msg.key.participantAlt)
              : rawSender;
            const senderName = msg.pushName || sender.split('@')[0];
            const fromMe = msg.key.fromMe || false;

            // Cloud mode: upload document attachments to S3 for processing pipeline
            if (process.env.NANOCLAW_ENV === 'cloud' && attachments.length > 0) {
              void (async () => {
                try {
                  const { getCloudServices } = await import('../cloud/bootstrap.js');
                  const services = getCloudServices();
                  if (!services) return;

                  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
                  const bucket = process.env.DATA_BUCKET;
                  if (!bucket) return;

                  const region = process.env.AWS_REGION || 'ap-southeast-1';
                  const s3 = new S3Client({ region });
                  const userId = sender.split('@')[0]; // phone number as userId

                  for (const att of attachments) {
                    if (att.type !== 'document' && att.type !== 'image') continue;
                    const filePath = path.join(DATA_DIR, att.localPath);
                    if (!fs.existsSync(filePath)) continue;

                    const fileBuffer = fs.readFileSync(filePath);
                    const uploadId = `wa-${msg.key.id || Date.now()}`;
                    const s3Key = `users/${userId}/staging/${uploadId}/${att.name}`;

                    await s3.send(new PutObjectCommand({
                      Bucket: bucket,
                      Key: s3Key,
                      Body: fileBuffer,
                      Metadata: { uploadId, originalFilename: att.name, userId },
                      // 24h staging TTL — see bucket lifecycle policy
                      Tagging: 'lifecycle=staging-24h',
                    }));

                    // Determine content type
                    const ext = path.extname(att.name).toLowerCase();
                    const mimeMap: Record<string, string> = {
                      '.pdf': 'application/pdf',
                      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                      '.csv': 'text/csv',
                      '.txt': 'text/plain',
                      '.md': 'text/plain',
                      '.jpg': 'image/jpeg',
                      '.jpeg': 'image/jpeg',
                      '.png': 'image/png',
                    };
                    const contentType = mimeMap[ext] || 'application/octet-stream';

                    await services.redis.lpush('nanoclaw:uploads:pending', JSON.stringify({
                      uploadId,
                      filename: att.name,
                      contentType,
                      s3Key,
                      bucket,
                      userId,
                      timestamp: new Date().toISOString(),
                    }));

                    log.info('WhatsApp document uploaded to S3 for processing', {
                      uploadId, filename: att.name, userId, s3Key,
                    });

                    // Ack to user so they know processing started
                    try {
                      await sendRawMessage(chatJid, `📥 Got "${att.name}" \u2014 indexing it now. Ask me about it in ~30s.`);
                    } catch { /* best effort */ }

                    // Cleanup local file after S3 upload
                    try { fs.unlinkSync(filePath); } catch { /* best effort */ }
                  }
                } catch (err) {
                  log.error('Failed to upload WhatsApp attachment to S3', { err });
                }
              })();
            }

            // Filter bot's own messages to prevent echo loops.
            // In self-chat (user messaging their own number), all messages have
            // fromMe=true — use sentMessageCache to distinguish bot echoes from
            // user-typed messages. For all other chats, the blanket fromMe
            // filter is correct since the user's phone messages shouldn't wake
            // the agent in third-party conversations.
            //
            // Single-number override: when the bot shares the user's WA number,
            // the user can still summon the bot from their own phone by prefixing
            // a message with one of WHATSAPP_OWNER_ALIASES (comma-separated, default
            // '@clawd'). The sentMessageCache check below still excludes the
            // bot's own outbound echoes; bot replies are prefixed `${ASSISTANT_NAME}: `
            // not `@clawd`, so they cannot match the alias gate.
            if (fromMe) {
              const isSelfChat = botPhoneJid && chatJid === botPhoneJid;
              const trimmed = content.trim().toLowerCase();
              // Require the alias to be followed by a word boundary (space,
              // punctuation, newline) or end-of-string. Plain startsWith()
              // would let `@clawding the cat` masquerade as a summon —
              // a real concern when the bot shares the user's number and
              // an accidental wake costs round-trip latency + token spend.
              const isOwnerAliasMention = OWNER_ALIASES.some((alias) => {
                if (!trimmed.startsWith(alias)) return false;
                if (trimmed.length === alias.length) return true;
                const next = trimmed.charAt(alias.length);
                // anything that isn't a letter/digit/underscore terminates the alias
                return !/[a-z0-9_]/i.test(next);
              });
              const allow = isSelfChat || isOwnerAliasMention;
              if (!allow) continue;
              if (sentMessageCache.has(msg.key.id || '')) continue;
            }

            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER ? false : content.startsWith(`${ASSISTANT_NAME}:`);

            // Check if this reply answers a pending question via slash command
            const pending = pendingQuestions.get(chatJid);
            if (pending && content.startsWith('/')) {
              const cmd = content.trim().toLowerCase();
              const matched = pending.options.find((o) => optionToCommand(o.label) === cmd);
              if (matched) {
                const voterName = msg.pushName || sender.split('@')[0];
                setupConfig.onAction(pending.questionId, matched.value, sender);
                pendingQuestions.delete(chatJid);
                await sendRawMessage(chatJid, `${matched.selectedLabel} by ${voterName}`);
                log.info('Question answered', {
                  questionId: pending.questionId,
                  value: matched.value,
                  voterName,
                });
                continue; // Don't forward this reply to the agent
              }
            }

            // Detect explicit @-mentions of the bot in groups. Detail in
            // isBotMentionedInGroup(); short version is contextInfo.mentionedJid
            // on text + caption-bearing messages, matched against the bot's
            // phone JID and LID (#2560).
            const botMentionedInGroup = isGroup && isBotMentionedInGroup(normalized, botPhoneJid, botLidUser);

            const inbound: InboundMessage = {
              id: msg.key.id || `wa-${Date.now()}`,
              kind: 'chat',
              // DMs are addressed to the bot by definition. Mark them as
              // platform-confirmed mentions so the router auto-creates an
              // approval-required messaging_group when the chat is unknown,
              // instead of silently dropping. In groups, only an explicit
              // @-mention counts.
              isMention: computeIsMention(isGroup, botMentionedInGroup),
              isGroup,
              content: {
                text: content,
                sender,
                senderName,
                ...(attachments.length > 0 && { attachments }),
                fromMe,
                isBotMessage,
                isGroup,
                chatJid,
              },
              timestamp,
            };

            // WhatsApp doesn't use threads — threadId is null
            log.info('Inbound WhatsApp message', {
              chatJid,
              isGroup,
              isMention: inbound.isMention,
              sender,
              senderName,
              attachments: attachments.length,
              textLen: content.length,
              fromMe,
            });
            setupConfig.onInbound(chatJid, null, inbound);
          } catch (err) {
            log.error('Error processing incoming WhatsApp message', {
              err,
              remoteJid: msg.key?.remoteJid,
            });
          }
        }
      });
    }

    // --- ChannelAdapter implementation ---

    const adapter: ChannelAdapter = {
      name: 'whatsapp',
      channelType: 'whatsapp',
      supportsThreads: false,

      async setup(hostConfig: ChannelSetup) {
        setupConfig = hostConfig;

        // Connect and wait for first open
        await new Promise<void>((resolve, reject) => {
          resolveFirstOpen = resolve;
          rejectFirstOpen = reject;
          connectSocket().catch(reject);
        });

        log.info('WhatsApp adapter initialized');
      },

      async deliver(
        platformId: string,
        _threadId: string | null,
        message: OutboundMessage,
      ): Promise<string | undefined> {
        const content = message.content as Record<string, unknown>;

        // Ask question → text with slash command replies
        if (content.type === 'ask_question' && content.questionId && content.options) {
          const questionId = content.questionId as string;
          const title = content.title as string;
          const question = content.question as string;
          if (!title) {
            log.error('ask_question missing required title — skipping delivery', { questionId });
            return;
          }
          const options: NormalizedOption[] = normalizeOptions(content.options as never);

          const optionLines = options.map((o) => `  ${optionToCommand(o.label)}`).join('\n');
          const text = `*${title}*\n\n${question}\n\nReply with:\n${optionLines}`;
          const msgId = await sendRawMessage(platformId, text);
          if (msgId) {
            pendingQuestions.set(platformId, { questionId, options });
            if (pendingQuestions.size > PENDING_QUESTIONS_MAX) {
              const oldest = pendingQuestions.keys().next().value!;
              pendingQuestions.delete(oldest);
            }
          }
          return msgId;
        }

        // Reaction → emoji on a message
        if (content.operation === 'reaction' && content.messageId && content.emoji) {
          try {
            await sock.sendMessage(platformId, {
              react: {
                text: content.emoji as string,
                key: { remoteJid: platformId, id: content.messageId as string, fromMe: false },
              },
            });
          } catch (err) {
            log.debug('Failed to send reaction', { platformId, err });
          }
          return;
        }

        // Image delivery (from generate_image tool)
        if (message.kind === 'image' && content.url) {
          try {
            const imgResp = await fetch(content.url as string);
            const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
            await sock.sendMessage(platformId, {
              image: imgBuffer,
              caption: (content.caption as string) || '',
              mimetype: 'image/png',
            });
          } catch (err) {
            log.error('Failed to send image message', { platformId, err });
            await sendRawMessage(platformId, `Sorry, couldn't send the image. Link: ${content.url as string}`);
          }
          return;
        }

        // Audio delivery (from text_to_speech tool)
        if (message.kind === 'audio' && content.url) {
          try {
            const audioResp = await fetch(content.url as string);
            const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
            await sock.sendMessage(platformId, {
              audio: audioBuffer,
              mimetype: 'audio/mpeg',
              ptt: false,
            });
          } catch (err) {
            log.error('Failed to send audio message', { platformId, err });
            await sendRawMessage(platformId, `Sorry, couldn't send the audio. Link: ${content.url as string}`);
          }
          return;
        }

        // Document delivery (from generate_document tool) -- send as file
        if (message.kind === 'document' && content.url) {
          try {
            const docResp = await fetch(content.url as string);
            const docBuffer = Buffer.from(await docResp.arrayBuffer());
            const filename = (content.url as string).split('/').pop()?.split('?')[0] || 'document.pdf';
            const caption = (content.caption as string) || '';
            await sock.sendMessage(platformId, {
              document: docBuffer,
              mimetype: filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
              fileName: filename,
              caption,
            });
          } catch (err) {
            log.error('Failed to send document message', { platformId, err });
            await sendRawMessage(platformId, `Here's your document: ${content.url as string}`);
          }
          return;
        }

        // Normal message (with optional file attachments)
        const text = (content.markdown as string) || (content.text as string);
        const hasFiles = message.files && message.files.length > 0;

        if (!text && !hasFiles) return;

        // Send file attachments (first file gets the caption, rest are captionless)
        if (hasFiles) {
          let captionUsed = false;
          for (const file of message.files!) {
            try {
              const ext = path.extname(file.filename).toLowerCase();
              const caption = !captionUsed ? text : undefined;
              const mediaMsg = buildMediaMessage(file.data, file.filename, ext, caption);
              const sent = await sock.sendMessage(platformId, mediaMsg);
              if (sent?.key?.id && sent.message) {
                sentMessageCache.set(sent.key.id, sent.message);
              }
              if (caption) captionUsed = true;
            } catch (err) {
              log.error('Failed to send file', { platformId, filename: file.filename, err });
            }
          }
          if (captionUsed) return; // Text was sent as caption
        }

        if (text) {
          const formatted = formatWhatsApp(text);
          const prefixed = ASSISTANT_HAS_OWN_NUMBER ? formatted : `${ASSISTANT_NAME}: ${formatted}`;
          return sendRawMessage(platformId, prefixed);
        }
      },

      async setTyping(platformId: string) {
        try {
          await sock.sendPresenceUpdate('composing', platformId);
        } catch (err) {
          log.debug('Failed to update typing status', { jid: platformId, err });
        }
      },

      async teardown() {
        connected = false;
        if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
        if (backupTimer) { clearTimeout(backupTimer); backupTimer = null; }
        // Final backup so the latest session state lives in S3 before container exit
        try {
          if (sessionBackup) await sessionBackup.backup();
        } catch (err) {
          log.warn('Final WA session backup failed', { err: err instanceof Error ? err.message : String(err) });
        }
        sock?.end(undefined);
        log.info('WhatsApp adapter shut down (session preserved in S3)');
      },

      async purgeSession() {
        connected = false;
        if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
        if (backupTimer) { clearTimeout(backupTimer); backupTimer = null; }
        // Tell WhatsApp to log this device out (best-effort, may already be disconnected)
        try { await sock?.logout(); } catch (err) {
          log.debug('WA logout call failed (proceeding with local purge)', { err: err instanceof Error ? err.message : String(err) });
        }
        sock?.end(undefined);
        // Wipe local auth dir
        try {
          if (fs.existsSync(authDir)) {
            for (const entry of fs.readdirSync(authDir)) {
              fs.rmSync(path.join(authDir, entry), { recursive: true, force: true });
            }
          }
          log.info('WA local auth dir purged');
        } catch (err) {
          log.warn('WA local auth dir purge failed', { err: err instanceof Error ? err.message : String(err) });
        }
        // Wipe S3 backup
        try {
          if (sessionBackup) {
            const r = await sessionBackup.purge();
            log.info('WA S3 session purged', { deleted: r.deleted.length, errors: r.errors.length });
          }
        } catch (err) {
          log.warn('WA S3 session purge failed', { err: err instanceof Error ? err.message : String(err) });
        }
      },

      isConnected() {
        return connected;
      },

      async syncConversations(): Promise<ConversationInfo[]> {
        try {
          const groups = await sock.groupFetchAllParticipating();
          return Object.entries(groups)
            .filter(([, m]) => m.subject)
            .map(([jid, m]) => ({
              platformId: jid,
              name: m.subject,
              isGroup: true,
            }));
        } catch (err) {
          log.error('Failed to sync WhatsApp conversations', { err });
          return [];
        }
      },
    };

    return adapter;
  },
});
