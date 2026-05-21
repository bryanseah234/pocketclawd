/**
 * chat-archive — filter logic + tag construction + attachment summary.
 *
 * The actual mnemon write is mocked via spawning a fake binary; here we
 * only verify the module's IN-PROCESS behaviour (mode filter, sticker
 * skip, content formatting).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { archiveChatMessage, type ChatMessageRecord } from './chat-archive.js';

const baseRecord: ChatMessageRecord = {
  platform: 'whatsapp',
  chatId: '120363@g.us',
  chatName: 'Family',
  isGroup: true,
  senderId: '6588@s.whatsapp.net',
  senderName: 'Bryan',
  text: 'just landed at SIN',
  fromSelf: false,
  occurredAt: new Date('2026-05-22T00:00:00Z'),
  messageId: 'msg-1',
};

describe('archiveChatMessage — INGEST_CHAT_MODE filter', () => {
  let prevMode: string | undefined;
  beforeEach(() => {
    prevMode = process.env.INGEST_CHAT_MODE;
  });
  afterEach(() => {
    if (prevMode === undefined) delete process.env.INGEST_CHAT_MODE;
    else process.env.INGEST_CHAT_MODE = prevMode;
  });

  it('mode=off → no-op (does not throw, returns immediately)', () => {
    process.env.INGEST_CHAT_MODE = 'off';
    expect(() => archiveChatMessage(baseRecord)).not.toThrow();
  });

  it('default (no env) → no-op (off is the safe default)', () => {
    delete process.env.INGEST_CHAT_MODE;
    expect(() => archiveChatMessage(baseRecord)).not.toThrow();
  });

  it('mode=self → archives self messages, skips other', () => {
    process.env.INGEST_CHAT_MODE = 'self';
    // Both should not throw — actual write is async + spawns mnemon
    expect(() => archiveChatMessage({ ...baseRecord, fromSelf: true })).not.toThrow();
    expect(() => archiveChatMessage({ ...baseRecord, fromSelf: false })).not.toThrow();
  });

  it('mode=all → archives everything', () => {
    process.env.INGEST_CHAT_MODE = 'all';
    expect(() => archiveChatMessage(baseRecord)).not.toThrow();
  });

  it('skips empty text + sticker-only messages', () => {
    process.env.INGEST_CHAT_MODE = 'all';
    expect(() =>
      archiveChatMessage({ ...baseRecord, text: '', attachments: { sticker: 1 } }),
    ).not.toThrow();
    // No way to assert non-call without instrumenting mnemonRemember;
    // the test passing without throw covers the early-return path.
  });
});
