/**
 * Tests for the kb_* MCP tools' transport: writes outbound kb_request,
 * blocks on a kb_response row landing in inbound.db, returns the result.
 *
 * We don't run the host's handler here — instead we pre-seed inbound.db
 * with a synthetic kb_response so pollForResponse returns immediately.
 * That isolates the container-side transport from host coupling and
 * proves the request/response correlation contract end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { kbRecall, kbRemember, kbStatus, requestHostKb } from './kb.js';

beforeEach(() => {
  initTestSessionDb();
  // getSessionRouting() falls back to all-nulls when session_routing table
  // is absent — that's the contract here, no seeding needed.
});

afterEach(() => {
  closeSessionDb();
});

/**
 * Helper: watch outbound until a kb_request lands, then plant a
 * matching kb_response in inbound. Mirrors what the host handler
 * would do.
 */
function seedKbResponseWhenRequestArrives(body: { ok: boolean; result?: unknown; error?: string }): Promise<void> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const out = getUndeliveredMessages();
      const req = out.find((m) => {
        if (m.kind !== 'system') return false;
        try {
          const parsed = JSON.parse(m.content);
          return parsed.action === 'kb_request';
        } catch {
          return false;
        }
      });
      if (req) {
        clearInterval(interval);
        const requestId = JSON.parse(req.content).request_id;
        getInboundDb()
          .prepare(
            `INSERT INTO messages_in (id, seq, kind, timestamp, content, trigger)
             VALUES ($id, $seq, 'system', $ts, $content, 0)`,
          )
          .run({
            $id: `kbres-msg-${requestId}`,
            $seq: 2,
            $ts: new Date().toISOString(),
            $content: JSON.stringify({ action: 'kb_response', request_id: requestId, ...body }),
          });
        resolve();
      }
    }, 20);
  });
}

describe('kb MCP tools transport', () => {
  it('kb_remember: writes request, awaits response, returns result text', async () => {
    const seedPromise = seedKbResponseWhenRequestArrives({ ok: true, result: { id: 99, created: true } });
    const [, toolResult] = await Promise.all([
      seedPromise,
      kbRemember.handler({ text: 'hello world', source: 'test' }),
    ]);

    expect(toolResult.isError).toBeUndefined();
    expect(toolResult.content[0].type).toBe('text');
    const parsed = JSON.parse((toolResult.content[0] as { text: string }).text);
    expect(parsed).toEqual({ id: 99, created: true });

    // Verify exactly one kb_request was written and it carries the args
    const out = getUndeliveredMessages();
    const reqs = out.filter((m) => m.kind === 'system' && m.content.includes('kb_request'));
    expect(reqs).toHaveLength(1);
    const reqBody = JSON.parse(reqs[0].content);
    expect(reqBody.tool).toBe('kb_remember');
    expect(reqBody.args).toEqual({ text: 'hello world', source: 'test' });
    expect(reqBody.request_id).toMatch(/^kbreq-/);
  });

  it('kb_recall: forwards args verbatim', async () => {
    const seedPromise = seedKbResponseWhenRequestArrives({ ok: true, result: { insights: [] } });
    await Promise.all([seedPromise, kbRecall.handler({ query: 'find me', k: 3 })]);

    const out = getUndeliveredMessages();
    const reqBody = JSON.parse(out[0].content);
    expect(reqBody.tool).toBe('kb_recall');
    expect(reqBody.args).toEqual({ query: 'find me', k: 3 });
  });

  it('kb_status: empty args object', async () => {
    const seedPromise = seedKbResponseWhenRequestArrives({
      ok: true,
      result: { total: 5, topEntities: [] },
    });
    const [, toolResult] = await Promise.all([seedPromise, kbStatus.handler({})]);

    const parsed = JSON.parse((toolResult.content[0] as { text: string }).text);
    expect(parsed.total).toBe(5);

    const reqBody = JSON.parse(getUndeliveredMessages()[0].content);
    expect(reqBody.args).toEqual({});
  });

  it('host ok:false → tool returns isError with the error text', async () => {
    const seedPromise = seedKbResponseWhenRequestArrives({ ok: false, error: 'PG down' });
    const [, toolResult] = await Promise.all([
      seedPromise,
      kbRemember.handler({ text: 'x' }),
    ]);

    expect(toolResult.isError).toBe(true);
    expect((toolResult.content[0] as { text: string }).text).toContain('PG down');
  });

  it('requestHostKb correlates by request_id even with stale rows in inbound', async () => {
    // Pre-plant a kb_response with a DIFFERENT request_id — the poller
    // must skip it and wait for the matching one.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, content, trigger)
         VALUES ('stale', 4, 'system', $ts, $content, 0)`,
      )
      .run({
        $ts: new Date().toISOString(),
        $content: JSON.stringify({ action: 'kb_response', request_id: 'kbreq-stale-9999', ok: true, result: 'WRONG' }),
      });

    const seedPromise = seedKbResponseWhenRequestArrives({ ok: true, result: 'CORRECT' });
    const [, result] = await Promise.all([seedPromise, requestHostKb('kb_status', {})]);
    expect(result).toBe('CORRECT');
  });
});
