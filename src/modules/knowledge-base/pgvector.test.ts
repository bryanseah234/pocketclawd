/**
 * pgvector KnowledgeBase tests.
 *
 * Strategy: real Postgres on localhost:5432 (the docker-compose service).
 * Ollama is mocked via fetch stub so tests don't depend on a running embedder
 * or a pulled model — synthetic 768-dim vectors are deterministic per text.
 *
 * Skip the entire suite if Postgres is unreachable. Tests that survive a
 * missing Ollama still validate the SQL paths, indexes, idempotency, edges,
 * recall ordering, and counts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PgVectorKB } from './pgvector.js';
import { _resetKnowledgeBaseForTest } from './index.js';
import { closePool } from './pg-client.js';

const PG_HOST = process.env.PGHOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.PGPORT ?? 5432);
const PG_DB = process.env.PGDATABASE ?? 'pocketclaw';
const PG_USER = process.env.PGUSER ?? 'pocketclaw';

/**
 * Probe Postgres at module load time. `it.skipIf` / `describe.skipIf` are
 * evaluated at collection time, BEFORE any beforeAll/beforeEach hook runs —
 * so the gate value must already be settled here.
 */
async function checkPostgres(): Promise<boolean> {
  const probe = new Pool({
    host: PG_HOST,
    port: PG_PORT,
    database: PG_DB,
    user: PG_USER,
    connectionTimeoutMillis: 1500,
  });
  try {
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}

const postgresAvailable = await checkPostgres();
if (!postgresAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[knowledge-base.test] Postgres unreachable on ${PG_HOST}:${PG_PORT} — pg-backed tests will be skipped.`,
  );
}

/**
 * Deterministic 768-dim "embedding" for a given text. Just hashes the input
 * to produce a vector — no semantics, but enough to differentiate rows in
 * cosine-distance tests (the order is reproducible given inputs).
 */
function syntheticEmbedding(text: string): number[] {
  const v = new Array<number>(768).fill(0);
  let h = 2166136261; // FNV-1a 32-bit seed
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Spread the hash across the vector deterministically
  for (let i = 0; i < 768; i++) {
    h = Math.imul(h ^ (h >>> 13), 16777619);
    v[i] = ((h & 0xffff) / 0xffff) * 2 - 1; // normalise to roughly [-1, 1]
  }
  return v;
}

// Stub global fetch so embed() does not call Ollama.
const originalFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('/api/embeddings')) {
      const body = JSON.parse((init?.body as string) ?? '{}') as { prompt?: string };
      return new Response(
        JSON.stringify({ embedding: syntheticEmbedding(body.prompt ?? '') }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(url, init);
  }) as typeof fetch;

});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await _resetKnowledgeBaseForTest();
  await closePool();
});

describe.skipIf(!postgresAvailable)('PgVectorKB', () => {
  // Even with the override above, skip if pg unreachable to allow local dev
  // without Docker running.
  let kb: PgVectorKB;
  let directPool: Pool;

  beforeAll(async () => {
    kb = await PgVectorKB.create();
    directPool = new Pool({ host: PG_HOST, port: PG_PORT, database: PG_DB, user: PG_USER });
  });

  beforeEach(async () => {
    // Wipe rows but keep schema. Test rows are tagged source LIKE 'kbtest%'.
    await directPool.query("DELETE FROM insights WHERE source LIKE 'kbtest%'");
  });

  afterAll(async () => {
    await directPool.query("DELETE FROM insights WHERE source LIKE 'kbtest%'");
    await directPool.end();
  });

  it('store creates a row', async () => {
    const result = await kb.store({
      text: 'the cat sat on the mat',
      source: 'kbtest',
      source_id: 'a1',
      category: 'pets',
      importance: 7,
      entities: ['cat', 'mat'],
      tags: ['feline'],
      metadata: { author: 'test' },
    });
    expect(result.id).toBeGreaterThan(0);
    expect(result.created).toBe(true);

    const { rows } = await directPool.query<{
      text: string; source: string; embed_model: string; importance: number;
    }>('SELECT text, source, embed_model, importance FROM insights WHERE id = $1', [result.id]);
    expect(rows[0]?.text).toBe('the cat sat on the mat');
    expect(rows[0]?.source).toBe('kbtest');
    expect(rows[0]?.embed_model).toBe('nomic-embed-text');
    expect(rows[0]?.importance).toBe(7);
  });

  it('store is idempotent on (source, source_id)', async () => {
    const first = await kb.store({ text: 'v1', source: 'kbtest', source_id: 'idem' });
    const second = await kb.store({ text: 'v2', source: 'kbtest', source_id: 'idem' });
    expect(first.id).toBe(second.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const { rows } = await directPool.query<{ text: string }>(
      'SELECT text FROM insights WHERE id = $1', [first.id],
    );
    expect(rows[0]?.text).toBe('v2'); // updated, not duplicated
  });

  it('storeBatch handles mixed new + existing rows', async () => {
    await kb.store({ text: 'pre-existing', source: 'kbtest', source_id: 'batch-a' });
    const result = await kb.storeBatch([
      { text: 'updated-a', source: 'kbtest', source_id: 'batch-a' },
      { text: 'fresh-b', source: 'kbtest', source_id: 'batch-b' },
      { text: 'fresh-c', source: 'kbtest', source_id: 'batch-c' },
    ]);
    expect(result.ids).toHaveLength(3);
    expect(result.created).toBe(2); // a was updated, b+c are new
  });

  it('recall returns rows ordered by cosine distance', async () => {
    const a = await kb.store({ text: 'apple', source: 'kbtest', source_id: 'r-a' });
    await kb.store({ text: 'banana', source: 'kbtest', source_id: 'r-b' });
    await kb.store({ text: 'cherry', source: 'kbtest', source_id: 'r-c' });

    // Query with the exact same text as 'apple' — synthetic embed is
    // deterministic, so 'apple' should be the nearest neighbour.
    const results = await kb.recall('apple', { k: 3, source: 'kbtest' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.id).toBe(a.id);
  });

  it('related returns neighbours of an anchor row', async () => {
    const anchor = await kb.store({ text: 'anchor', source: 'kbtest', source_id: 'rel-x' });
    await kb.store({ text: 'sibling-1', source: 'kbtest', source_id: 'rel-y' });
    await kb.store({ text: 'sibling-2', source: 'kbtest', source_id: 'rel-z' });

    const neighbours = await kb.related(anchor.id, 5);
    expect(neighbours.find((n) => n.id === anchor.id)).toBeUndefined();
    expect(neighbours.length).toBeGreaterThanOrEqual(1);
  });

  it('link inserts an edge and is idempotent', async () => {
    const a = await kb.store({ text: 'edge-from', source: 'kbtest', source_id: 'e-a' });
    const b = await kb.store({ text: 'edge-to', source: 'kbtest', source_id: 'e-b' });

    await kb.link(a.id, b.id, 'related', 0.5);
    await kb.link(a.id, b.id, 'related', 0.9); // same triple, weight updated

    const { rows } = await directPool.query<{ count: string; weight: number }>(
      'SELECT COUNT(*)::text AS count, MAX(weight) AS weight FROM edges WHERE from_id = $1 AND to_id = $2 AND kind = $3',
      [a.id, b.id, 'related'],
    );
    expect(Number(rows[0]?.count)).toBe(1);
    expect(rows[0]?.weight).toBeCloseTo(0.9);
  });

  it('forget cascades to edges', async () => {
    const a = await kb.store({ text: 'doomed-a', source: 'kbtest', source_id: 'd-a' });
    const b = await kb.store({ text: 'doomed-b', source: 'kbtest', source_id: 'd-b' });
    await kb.link(a.id, b.id, 'related');

    await kb.forget(a.id);

    const insights = await directPool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM insights WHERE id = $1', [a.id],
    );
    expect(Number(insights.rows[0]?.count)).toBe(0);

    const edges = await directPool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM edges WHERE from_id = $1 OR to_id = $1', [a.id],
    );
    expect(Number(edges.rows[0]?.count)).toBe(0);
  });

  it('count filters by source', async () => {
    await kb.store({ text: 'count-1', source: 'kbtest-a', source_id: 'c-1' });
    await kb.store({ text: 'count-2', source: 'kbtest-a', source_id: 'c-2' });
    await kb.store({ text: 'count-3', source: 'kbtest-b', source_id: 'c-3' });

    expect(await kb.count({ source: 'kbtest-a' })).toBe(2);
    expect(await kb.count({ source: 'kbtest-b' })).toBe(1);
  });
});

// Always-runnable unit-level tests that don't need Postgres
describe('KnowledgeBase pure helpers', () => {
  it('toVectorLiteral formats vectors correctly', async () => {
    const { toVectorLiteral } = await import('./embed.js');
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
    expect(toVectorLiteral([])).toBe('[]');
  });
});
