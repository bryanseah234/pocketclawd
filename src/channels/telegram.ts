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

    // Only handle text messages for now; photo/doc can be added later
    const text = msg.text ?? msg.caption ?? '';
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

interface TgMessage {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
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
