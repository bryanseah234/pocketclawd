/**
 * Unit tests for the kb_request delivery action handler.
 *
 * Strategy: stub the KnowledgeBase resolver, capture writeSessionMessage
 * via vi.mock, and assert the handler writes a correctly-shaped
 * kb_response system message back into inbound.db with ok:true on
 * success and ok:false on permission refusal / tool error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';
import { _resetKbResolverForTest, _setKbResolverForTest, handleKbRequest } from './kb-actions.js';
import type { Insight, KnowledgeBase } from './index.js';

const writeSessionMessageMock = vi.fn();

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => writeSessionMessageMock(...args),
}));

vi.mock('../../log.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeStubKb(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return {
    store: vi.fn().mockResolvedValue({ id: 1, created: true }),
    storeBatch: vi.fn().mockResolvedValue({ ids: [], created: 0 }),
    recall: vi.fn().mockResolvedValue([] as Insight[]),
    related: vi.fn().mockResolvedValue([] as Insight[]),
    link: vi.fn().mockResolvedValue(undefined),
    forget: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    topEntities: vi.fn().mockResolvedValue([]),
    lowImportance: vi.fn().mockResolvedValue([] as Insight[]),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSession(agent_group_id = 'pocketclaw'): Session {
  return {
    id: 'sess-1',
    agent_group_id,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: 'claude',
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

const fakeDb = {} as never;

describe('handleKbRequest', () => {
  beforeEach(() => {
    writeSessionMessageMock.mockReset();
  });
  afterEach(() => {
    _resetKbResolverForTest();
  });

  it('kb_remember stores and replies ok:true', async () => {
    const stub = makeStubKb({ store: vi.fn().mockResolvedValue({ id: 42, created: true }) });
    _setKbResolverForTest(async () => stub);

    await handleKbRequest(
      { request_id: 'r1', tool: 'kb_remember', args: { text: 'hello world', source: 'test' } },
      makeSession(),
      fakeDb,
    );

    expect(stub.store).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello world', source: 'test' }));
    expect(writeSessionMessageMock).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId, message] = writeSessionMessageMock.mock.calls[0];
    expect(agentGroupId).toBe('pocketclaw');
    expect(sessionId).toBe('sess-1');
    expect(message.kind).toBe('system');
    expect(message.trigger).toBe(0);
    const body = JSON.parse(message.content);
    expect(body).toEqual({
      action: 'kb_response',
      request_id: 'r1',
      ok: true,
      result: { id: 42, created: true },
    });
  });

  it('kb_recall trims insights to wire shape', async () => {
    const stub = makeStubKb({
      recall: vi.fn().mockResolvedValue([
        { id: 1, text: 'a', source: 'chat', tags: ['x'], embed_model: 'should-be-stripped' },
        { id: 2, text: 'b', source: 'chat' },
      ] as Insight[]),
    });
    _setKbResolverForTest(async () => stub);

    await handleKbRequest(
      { request_id: 'r2', tool: 'kb_recall', args: { query: 'hi', k: 2 } },
      makeSession(),
      fakeDb,
    );

    expect(stub.recall).toHaveBeenCalledWith('hi', { k: 2 });
    const body = JSON.parse(writeSessionMessageMock.mock.calls[0][2].content);
    expect(body.ok).toBe(true);
    expect(body.result.insights).toHaveLength(2);
    expect(body.result.insights[0]).not.toHaveProperty('embed_model');
    expect(body.result.insights[0].text).toBe('a');
  });

  it('kb_status returns total + top entities', async () => {
    const stub = makeStubKb({
      count: vi.fn().mockResolvedValue(7),
      topEntities: vi.fn().mockResolvedValue([{ entity: 'alice', count: 3 }]),
    });
    _setKbResolverForTest(async () => stub);

    await handleKbRequest({ request_id: 'r3', tool: 'kb_status', args: {} }, makeSession(), fakeDb);

    const body = JSON.parse(writeSessionMessageMock.mock.calls[0][2].content);
    expect(body).toEqual({
      action: 'kb_response',
      request_id: 'r3',
      ok: true,
      result: { total: 7, topEntities: [{ entity: 'alice', count: 3 }] },
    });
  });

  it('refuses kb_* outside the pocketclaw agent group', async () => {
    const stub = makeStubKb();
    _setKbResolverForTest(async () => stub);

    await handleKbRequest(
      { request_id: 'r4', tool: 'kb_remember', args: { text: 'x' } },
      makeSession('random-group'),
      fakeDb,
    );

    expect(stub.store).not.toHaveBeenCalled();
    const body = JSON.parse(writeSessionMessageMock.mock.calls[0][2].content);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/restricted to the pocketclaw agent group/);
    expect(body.error).toContain('random-group');
  });

  it('returns ok:false on tool errors', async () => {
    const stub = makeStubKb({ store: vi.fn().mockRejectedValue(new Error('PG down')) });
    _setKbResolverForTest(async () => stub);

    await handleKbRequest(
      { request_id: 'r5', tool: 'kb_remember', args: { text: 'x' } },
      makeSession(),
      fakeDb,
    );

    const body = JSON.parse(writeSessionMessageMock.mock.calls[0][2].content);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('PG down');
  });

  it('returns ok:false on validation errors', async () => {
    const stub = makeStubKb();
    _setKbResolverForTest(async () => stub);

    await handleKbRequest(
      { request_id: 'r6', tool: 'kb_remember', args: {} },
      makeSession(),
      fakeDb,
    );

    expect(stub.store).not.toHaveBeenCalled();
    const body = JSON.parse(writeSessionMessageMock.mock.calls[0][2].content);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/text.*required/);
  });

  it('silently drops requests missing request_id (no way to respond)', async () => {
    const stub = makeStubKb();
    _setKbResolverForTest(async () => stub);

    await handleKbRequest({ tool: 'kb_remember', args: { text: 'x' } }, makeSession(), fakeDb);

    expect(writeSessionMessageMock).not.toHaveBeenCalled();
    expect(stub.store).not.toHaveBeenCalled();
  });

  it('rejects unknown kb tools with ok:false', async () => {
    const stub = makeStubKb();
    _setKbResolverForTest(async () => stub);

    await handleKbRequest(
      { request_id: 'r7', tool: 'kb_nonsense', args: {} },
      makeSession(),
      fakeDb,
    );

    const body = JSON.parse(writeSessionMessageMock.mock.calls[0][2].content);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Unknown kb tool/);
  });
});
