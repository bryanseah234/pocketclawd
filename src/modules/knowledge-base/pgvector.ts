/**
 * pgvector-backed KnowledgeBase implementation.
 *
 * All vector ops use cosine distance (`<=>` operator). The HNSW index on
 * `insights.embedding` was created with `vector_cosine_ops` in 001_init.sql.
 *
 * Idempotency: `store` and `storeBatch` use `INSERT ... ON CONFLICT (source,
 * source_id) DO UPDATE` so re-ingesting the same source row refreshes its
 * embedding + metadata without creating a duplicate. The `created` flag in
 * the return value tells callers whether a new row was inserted (true) or an
 * existing one was updated (false).
 */

import type { Insight, KnowledgeBase, RecallOptions } from './index.js';
import { getPool, runMigrations, closePool } from './pg-client.js';
import { embed, toVectorLiteral } from './embed.js';

export class PgVectorKB implements KnowledgeBase {
  private constructor() {}

  /**
   * Create the KB. Runs migrations on first call (idempotent, safe to re-run).
   */
  static async create(): Promise<PgVectorKB> {
    // Ensure the pool is initialised and migrations are applied.
    getPool();
    await runMigrations();
    return new PgVectorKB();
  }

  async store(insight: Insight): Promise<{ id: number; created: boolean }> {
    const pool = getPool();
    const { vector, model } = await embed(insight.text);
    const vecLiteral = toVectorLiteral(vector);

    const result = await pool.query<{ id: number; created: boolean }>(
      `
      INSERT INTO insights
        (text, embedding, embed_model, source, source_id, category, importance, entities, tags, metadata)
      VALUES
        ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (source, source_id) DO UPDATE SET
        text       = EXCLUDED.text,
        embedding  = EXCLUDED.embedding,
        embed_model = EXCLUDED.embed_model,
        category   = EXCLUDED.category,
        importance = EXCLUDED.importance,
        entities   = EXCLUDED.entities,
        tags       = EXCLUDED.tags,
        metadata   = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING id, (xmax = 0) AS created
      `,
      [
        insight.text,
        vecLiteral,
        model,
        insight.source,
        insight.source_id ?? null,
        insight.category ?? null,
        insight.importance ?? 5,
        insight.entities ?? [],
        insight.tags ?? [],
        insight.metadata ?? {},
      ],
    );
    const row = result.rows[0]!;
    return { id: row.id, created: row.created };
  }

  async storeBatch(insights: Insight[]): Promise<{ ids: number[]; created: number }> {
    if (insights.length === 0) return { ids: [], created: 0 };

    // Embed in parallel (Ollama can handle ~8 concurrent locally)
    const PARALLEL = Number(process.env.KB_EMBED_CONCURRENCY ?? 4);
    const embeddings: { vector: number[]; model: string }[] = new Array(insights.length);
    for (let i = 0; i < insights.length; i += PARALLEL) {
      const slice = insights.slice(i, i + PARALLEL);
      const results = await Promise.all(slice.map((ins) => embed(ins.text)));
      for (let j = 0; j < results.length; j++) {
        embeddings[i + j] = results[j]!;
      }
    }

    // One INSERT statement with VALUES tuples; small batch so this is fine.
    // For huge batches, consider pg-copy-streams instead.
    const pool = getPool();
    const client = await pool.connect();
    const ids: number[] = [];
    let created = 0;
    try {
      await client.query('BEGIN');
      for (let i = 0; i < insights.length; i++) {
        const ins = insights[i]!;
        const emb = embeddings[i]!;
        const result = await client.query<{ id: number; created: boolean }>(
          `
          INSERT INTO insights
            (text, embedding, embed_model, source, source_id, category, importance, entities, tags, metadata)
          VALUES
            ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (source, source_id) DO UPDATE SET
            text       = EXCLUDED.text,
            embedding  = EXCLUDED.embedding,
            embed_model = EXCLUDED.embed_model,
            category   = EXCLUDED.category,
            importance = EXCLUDED.importance,
            entities   = EXCLUDED.entities,
            tags       = EXCLUDED.tags,
            metadata   = EXCLUDED.metadata,
            updated_at = NOW()
          RETURNING id, (xmax = 0) AS created
          `,
          [
            ins.text,
            toVectorLiteral(emb.vector),
            emb.model,
            ins.source,
            ins.source_id ?? null,
            ins.category ?? null,
            ins.importance ?? 5,
            ins.entities ?? [],
            ins.tags ?? [],
            ins.metadata ?? {},
          ],
        );
        const row = result.rows[0]!;
        ids.push(row.id);
        if (row.created) created++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { ids, created };
  }

  async recall(query: string, opts: RecallOptions = {}): Promise<Insight[]> {
    const k = opts.k ?? 10;
    const pool = getPool();
    const { vector } = await embed(query);
    const vecLiteral = toVectorLiteral(vector);

    const where: string[] = ['embedding IS NOT NULL'];
    const params: unknown[] = [vecLiteral];
    let p = 2;

    if (opts.source) {
      where.push(`source = $${p++}`);
      params.push(opts.source);
    }
    if (opts.since) {
      where.push(`created_at >= $${p++}`);
      params.push(opts.since);
    }

    params.push(k);

    const result = await pool.query<DbInsightRow>(
      `
      SELECT id, text, embed_model, source, source_id, category, importance,
             entities, tags, metadata, created_at, updated_at
      FROM insights
      WHERE ${where.join(' AND ')}
      ORDER BY embedding <=> $1::vector
      LIMIT $${p}
      `,
      params,
    );

    return result.rows.map(rowToInsight);
  }

  async related(id: number, k = 10): Promise<Insight[]> {
    const pool = getPool();
    const result = await pool.query<DbInsightRow>(
      `
      SELECT i.id, i.text, i.embed_model, i.source, i.source_id, i.category,
             i.importance, i.entities, i.tags, i.metadata, i.created_at, i.updated_at
      FROM insights anchor
      JOIN insights i ON i.id != anchor.id
      WHERE anchor.id = $1
        AND anchor.embedding IS NOT NULL
        AND i.embedding IS NOT NULL
      ORDER BY i.embedding <=> anchor.embedding
      LIMIT $2
      `,
      [id, k],
    );
    return result.rows.map(rowToInsight);
  }

  async link(fromId: number, toId: number, kind: string, weight = 1.0): Promise<void> {
    const pool = getPool();
    await pool.query(
      `
      INSERT INTO edges (from_id, to_id, kind, weight)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (from_id, to_id, kind) DO UPDATE SET weight = EXCLUDED.weight
      `,
      [fromId, toId, kind, weight],
    );
  }

  async forget(id: number): Promise<void> {
    const pool = getPool();
    // edges cascade via ON DELETE CASCADE in the schema
    await pool.query('DELETE FROM insights WHERE id = $1', [id]);
  }

  async count(filter: { source?: string } = {}): Promise<number> {
    const pool = getPool();
    if (filter.source) {
      const r = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM insights WHERE source = $1',
        [filter.source],
      );
      return Number(r.rows[0]!.count);
    }
    const r = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM insights');
    return Number(r.rows[0]!.count);
  }

  async close(): Promise<void> {
    await closePool();
  }
}

interface DbInsightRow {
  id: number;
  text: string;
  embed_model: string;
  source: string;
  source_id: string | null;
  category: string | null;
  importance: number | null;
  entities: string[] | null;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

function rowToInsight(row: DbInsightRow): Insight {
  return {
    id: row.id,
    text: row.text,
    embed_model: row.embed_model,
    source: row.source,
    source_id: row.source_id ?? undefined,
    category: row.category ?? undefined,
    importance: row.importance ?? undefined,
    entities: row.entities ?? undefined,
    tags: row.tags ?? undefined,
    metadata: row.metadata ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
