/**
 * Tests for MessageDebouncer (PRD §11.1)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  MessageDebouncer,
  MessageType,
  QueuedMessage,
  formatBatchPrompt,
} from './debouncer.js';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function mk(
  partial: Partial<QueuedMessage> & { text?: string; type?: MessageType },
): QueuedMessage {
  return {
    platform: partial.platform ?? 'telegram',
    timestamp: partial.timestamp ?? Date.now(),
    messageId: partial.messageId ?? Math.random().toString(36).slice(2),
    text: partial.text ?? '',
    messageType: partial.type ?? partial.messageType ?? MessageType.TEXT,
    attachmentPath: partial.attachmentPath,
  };
}

describe('MessageDebouncer', () => {
  let batches: { sessionId: string; messages: QueuedMessage[] }[];

  beforeEach(() => {
    batches = [];
  });

  it('batches three messages within window into one batch', async () => {
    const d = new MessageDebouncer((sid, msgs) => {
      batches.push({ sessionId: sid, messages: msgs });
    }, 200);

    d.push('s1', mk({ text: 'one' }));
    d.push('s1', mk({ text: 'two' }));
    d.push('s1', mk({ text: 'three' }));

    await wait(400);

    expect(batches).toHaveLength(1);
    expect(batches[0]!.messages).toHaveLength(3);
    expect(batches[0]!.sessionId).toBe('s1');
  });

  it('messages outside window produce separate batches', async () => {
    const d = new MessageDebouncer((sid, msgs) => {
      batches.push({ sessionId: sid, messages: msgs });
    }, 100);

    d.push('s1', mk({ text: 'one' }));
    await wait(200);
    d.push('s1', mk({ text: 'two' }));
    await wait(200);

    expect(batches).toHaveLength(2);
    expect(batches[0]!.messages).toHaveLength(1);
    expect(batches[1]!.messages).toHaveLength(1);
  });

  it('stickers are silently dropped — no batch emitted', async () => {
    const d = new MessageDebouncer((sid, msgs) => {
      batches.push({ sessionId: sid, messages: msgs });
    }, 100);

    d.push('s1', mk({ text: '', type: MessageType.STICKER }));
    d.push('s1', mk({ text: '', type: MessageType.STICKER }));

    await wait(300);

    expect(batches).toHaveLength(0);
    expect(d.size()).toBe(0);
  });

  it('cross-platform same session merges Telegram + WhatsApp', async () => {
    const d = new MessageDebouncer((sid, msgs) => {
      batches.push({ sessionId: sid, messages: msgs });
    }, 200);

    d.push('user-bryan', mk({ platform: 'telegram', text: 'from tg' }));
    d.push('user-bryan', mk({ platform: 'whatsapp', text: 'from wa' }));

    await wait(400);

    expect(batches).toHaveLength(1);
    expect(batches[0]!.messages).toHaveLength(2);
    const platforms = batches[0]!.messages.map((m) => m.platform);
    expect(platforms).toContain('telegram');
    expect(platforms).toContain('whatsapp');
  });

  it('different sessions produce separate batches', async () => {
    const d = new MessageDebouncer((sid, msgs) => {
      batches.push({ sessionId: sid, messages: msgs });
    }, 200);

    d.push('user-a', mk({ text: 'a' }));
    d.push('user-b', mk({ text: 'b' }));

    await wait(400);

    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.sessionId).sort()).toEqual(['user-a', 'user-b']);
  });

  it('flush() emits queued messages immediately', async () => {
    const d = new MessageDebouncer((sid, msgs) => {
      batches.push({ sessionId: sid, messages: msgs });
    }, 10000);

    d.push('s1', mk({ text: 'instant' }));
    await d.flush('s1');

    expect(batches).toHaveLength(1);
    expect(batches[0]!.messages[0]!.text).toBe('instant');
  });
});

describe('formatBatchPrompt', () => {
  it('wraps messages in BATCH START/END markers', () => {
    const t0 = Date.parse('2026-05-20T14:32:01Z');
    const messages: QueuedMessage[] = [
      mk({ platform: 'telegram', timestamp: t0, text: 'summary' }),
      mk({ platform: 'whatsapp', timestamp: t0 + 2000, text: 'also remind' }),
    ];

    const out = formatBatchPrompt(messages);

    expect(out).toContain('[BATCH START — 2 messages, 2.0s window]');
    expect(out).toContain('[BATCH END]');
    expect(out).toContain('telegram');
    expect(out).toContain('whatsapp');
    expect(out).toContain('summary');
    expect(out).toContain('also remind');
  });

  it('tags photo messages with [PHOTO ATTACHED]', () => {
    const messages: QueuedMessage[] = [
      mk({
        platform: 'telegram',
        text: 'whiteboard',
        type: MessageType.PHOTO,
        attachmentPath: '/tmp/photo.jpg',
      }),
    ];
    const out = formatBatchPrompt(messages);
    expect(out).toContain('[PHOTO ATTACHED]');
  });

  it('returns empty string for empty input', () => {
    expect(formatBatchPrompt([])).toBe('');
  });
});
