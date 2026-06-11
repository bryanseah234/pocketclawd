/**
 * Telegram channel adapter — long-poll bot.
 *
 * Enabled via TELEGRAM_ENABLED=true + TELEGRAM_BOT_TOKEN=<token>.
 * Long-poll (getUpdates offset-based) is used; webhook support can be added
 * later once Caddy/HTTPS (C9) is in place.
 *
 * channelType: 'telegram'
 * platformId:  Telegram chat_id (string)
 * userId:      'tg:<telegram_user_id>' (set by sender-resolver prefix map)
 * threadId:    null (Telegram DMs are flat; group thread_id not yet used)
 */

import { registerChannelAdapter } from './channel-registry.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const POLL_TIMEOUT = 30; // long-poll seconds per getUpdates call
const MAX_CONNECTIONS = 1; // single poller

// ── Telegram API helpers ──────────────────────────────────────────────────────

async function tgCall(method: string, body?: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${TELEGRAM_API}/${method}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Telegram ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method} error: ${json.description}`);
    return json.result;
}

async function tgDownloadFile(fileId: string): Promise<Buffer> {
    // Two-step: getFile -> file_path, then download from the file endpoint.
    const fileInfo = (await tgCall('getFile', { file_id: fileId })) as { file_path?: string };
    if (!fileInfo.file_path) throw new Error('Telegram getFile returned no file_path');
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Telegram file download HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

// ── Adapter ───────────────────────────────────────────────────────────────────

let setupConfig: ChannelSetup | null = null;
let polling = false;
let nextOffset = 0;

async function pollLoop(): Promise<void> {
    log.info('Telegram long-poll loop started');
    while (polling) {
        try {
            const updates = (await tgCall('getUpdates', {
                offset: nextOffset,
                timeout: POLL_TIMEOUT,
                allowed_updates: ['message'],
            })) as TgUpdate[];

            for (const upd of updates) {
                nextOffset = upd.update_id + 1;
                if (!upd.message) continue;
                handleUpdate(upd.message).catch((err) =>
                    log.error('Telegram message handler error', { err, updateId: upd.update_id }),
                );
            }
        } catch (err) {
            if (!polling) break; // normal teardown
            log.warn('Telegram getUpdates error, retrying in 5s', { err });
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
    log.info('Telegram long-poll loop stopped');
}

async function handleUpdate(msg: TgMessage): Promise<void> {
    if (!setupConfig) return;

    const chatId = String(msg.chat.id);
    const senderId = String(msg.from?.id ?? msg.chat.id);
    const senderName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
        || msg.from?.username
        || chatId;

    const text = msg.text ?? msg.caption ?? '';

    // Wave 2: inbound file handling. Telegram photos/documents were previously
    // dropped here ("text only"). Download them, push to the S3 staging +
    // indexing pipeline (same path WhatsApp uses), and ack the user. The
    // caption (if any) still flows on to the agent as a normal chat message.
    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
    const hasDoc = !!msg.document;
    if ((hasPhoto || hasDoc) && process.env.NANOCLAW_ENV === 'cloud') {
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

                // CANONICAL userId — MUST match the router senderResolver for
                // Telegram (`tg:<senderId>`) so the uploaded doc indexes under
                // the same id the chat/RAG pipeline filters on.
                const userId = `tg:${senderId}`;

                // Resolve the file to download + a filename + content type.
                let fileId: string;
                let filename: string;
                let contentType: string;
                if (hasDoc) {
                    fileId = msg.document!.file_id;
                    filename = msg.document!.file_name || `tg-doc-${msg.message_id}`;
                    contentType = msg.document!.mime_type || 'application/octet-stream';
                } else {
                    // Largest photo size is the last entry.
                    const largest = msg.photo![msg.photo!.length - 1];
                    fileId = largest.file_id;
                    filename = `tg-photo-${msg.message_id}.jpg`;
                    contentType = 'image/jpeg';
                }

                const fileBuffer = await tgDownloadFile(fileId);
                const uploadId = `tg-${msg.message_id}`;
                const s3Key = `users/${userId}/staging/${uploadId}/${filename}`;

                await s3.send(new PutObjectCommand({
                    Bucket: bucket,
                    Key: s3Key,
                    Body: fileBuffer,
                    Metadata: { uploadId, originalFilename: filename, userId },
                    Tagging: 'lifecycle=staging-24h',
                }));

                await services.redis.lpush('nanoclaw:uploads:pending', JSON.stringify({
                    uploadId,
                    filename,
                    contentType,
                    s3Key,
                    bucket,
                    userId,
                    channelType: 'telegram',
                    platformId: chatId,
                    timestamp: new Date().toISOString(),
                }));

                log.info('Telegram file uploaded to S3 for indexing', { uploadId, filename, userId, s3Key });
                await sendTelegramMessage(chatId, `\u{1F4E5} Got "${filename}" \u2014 indexing it now. Ask me about it in ~30s.`);
            } catch (err) {
                log.error('Failed to handle Telegram inbound file', { err });
            }
        })();
    }

    // If there is no text/caption AND no file, nothing to forward.
    if (!text.trim() && !hasPhoto && !hasDoc) return;
    // A bare file with no caption: the upload pipeline handles it; don't also
    // forward an empty chat message to the agent.
    if (!text.trim()) return;

    const inbound: InboundMessage = {
        id: `tg-${msg.message_id}`,
        kind: 'chat',
        isMention: msg.chat.type === 'private', // DMs are always "mentions"
        isGroup: msg.chat.type !== 'private',
        content: {
            text,
            sender: senderId,
            senderId,
            senderName,
            chatId,
            isGroup: msg.chat.type !== 'private',
            fromMe: false,
        },
        timestamp: new Date(msg.date * 1000).toISOString(),
    };

    log.info('Inbound Telegram message', { chatId, senderId, textLen: text.length });
    setupConfig.onInbound(chatId, null, inbound);
}

async function sendTelegramMessage(chatId: string, text: string): Promise<string | undefined> {
    try {
        const result = (await tgCall('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML', // matches WhatsApp bold/italic conventions
        })) as { message_id: number };
        return String(result.message_id);
    } catch (err) {
        log.error('Telegram sendMessage failed', { chatId, err });
        return undefined;
    }
}

const adapter: ChannelAdapter = {
    name: 'telegram',
    channelType: 'telegram',
    supportsThreads: false,

    async setup(hostConfig: ChannelSetup): Promise<void> {
        setupConfig = hostConfig;

        if (!BOT_TOKEN) {
            log.warn('Telegram adapter: TELEGRAM_BOT_TOKEN not set — adapter inactive');
            return;
        }

        // Confirm bot identity
        try {
            const me = (await tgCall('getMe')) as { username?: string; first_name?: string };
            log.info('Telegram bot connected', { username: me.username ?? me.first_name });
        } catch (err) {
            log.error('Telegram getMe failed — adapter will not start', { err });
            return;
        }

        // Drop any pending webhook so long-poll works cleanly
        await tgCall('deleteWebhook', { drop_pending_updates: false }).catch(() => {/* best-effort */});

        polling = true;
        void pollLoop();
        log.info('Telegram adapter initialized');
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
        const content = message.content as Record<string, unknown>;

        // ask_question → numbered option list (mirrors WhatsApp format)
        if (content.type === 'ask_question' && content.options) {
            const options = (content.options as Array<{ label: string; value?: string }>)
                .map((o, i) => `  /${i + 1} ${o.label}`)
                .join('\n');
            const text = `<b>${content.title ?? 'Question'}</b>\n\n${content.question ?? ''}\n\nReply with:\n${options}`;
            return sendTelegramMessage(platformId, text);
        }

        // Image delivery (from generate_image tool)
        if (message.kind === 'image' && typeof content.url === 'string') {
            try {
                await tgCall('sendPhoto', {
                    chat_id: platformId,
                    photo: content.url as string,
                    caption: (content.caption as string) || '',
                });
            } catch (err) {
                log.error('Failed to send Telegram photo', { platformId, err });
                await sendTelegramMessage(platformId, `Here's your image: ${content.url as string}`);
            }
            return;
        }

        // Audio delivery (from text_to_speech tool)
        if (message.kind === 'audio' && typeof content.url === 'string') {
            try {
                await tgCall('sendAudio', {
                    chat_id: platformId,
                    audio: content.url as string,
                });
            } catch (err) {
                log.error('Failed to send Telegram audio', { platformId, err });
                await sendTelegramMessage(platformId, `Here's your audio: ${content.url as string}`);
            }
            return;
        }

        // Document delivery (from generate_document tool)
        if (message.kind === 'document' && typeof content.url === 'string') {
            try {
                const caption = (content.caption as string) || '';
                await tgCall('sendDocument', {
                    chat_id: platformId,
                    document: content.url as string,
                    caption,
                });
            } catch (err) {
                log.error('Failed to send Telegram document', { platformId, err });
                await sendTelegramMessage(platformId, `Here's your document: ${content.url as string}`);
            }
            return;
        }

        // Plain text — WhatsApp *bold* → Telegram <b>bold</b>
        const raw = typeof content.text === 'string' ? content.text : JSON.stringify(content);
        const html = raw.replace(/\*(.*?)\*/g, '<b>$1</b>');
        return sendTelegramMessage(platformId, html);
    },

    async teardown(): Promise<void> {
        polling = false;
        log.info('Telegram adapter torn down');
    },

    isConnected(): boolean {
        return polling && BOT_TOKEN.length > 0;
    },
};

// ── Types ────────────────────────────────────────────────────────────────────

interface TgUpdate {
    update_id: number;
    message?: TgMessage;
}

interface TgPhotoSize {
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
}

interface TgDocument {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}

interface TgMessage {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    photo?: TgPhotoSize[];
    document?: TgDocument;
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
}

// ── Registration ──────────────────────────────────────────────────────────────

// Adapter is always registered; it self-disables in setup() when
// TELEGRAM_ENABLED != 'true' or TELEGRAM_BOT_TOKEN is not set.
registerChannelAdapter('telegram', {
    factory: async () => {
        if (process.env.TELEGRAM_ENABLED !== 'true') return null;
        return adapter;
    },
});
