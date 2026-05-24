/**
 * Knowledge base abstraction.
 *
 * Vendor-neutral interface — the codebase talks to `KnowledgeBase`, not to
 * Postgres or pgvector directly. Implementations live in sibling files
 * (`pgvector.ts` is the only one for now).
 *
 * Design notes:
 * - `embed_model` is set by the impl from whatever embedder it uses; callers
 *   never supply it. This keeps "what produced this vector" forensically
 *   recorded per row without polluting the caller surface.
 * - `store` is idempotent on `(source, source_id)` — caller passes the same
 *   pair on retry, no duplicate row.
 * - `recall` returns insights ordered by relevance to a free-text query.
 */

export interface Insight {
  id?: number;
  text: string;
  source: string;
  source_id?: string;
  category?: string;
  importance?: number;
  entities?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  /**
   * Set by the impl from the embedder it uses. Callers do not supply this.
   */
  embed_model?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface RecallOptions {
  k?: number;
  source?: string;
  since?: Date;
}

export interface KnowledgeBase {
  store(insight: Insight): Promise<{ id: number; created: boolean }>;
  storeBatch(insights: Insight[]): Promise<{ ids: number[]; created: number }>;
  recall(query: string, opts?: RecallOptions): Promise<Insight[]>;
  related(id: number, k?: number): Promise<Insight[]>;
  link(fromId: number, toId: number, kind: string, weight?: number): Promise<void>;
  forget(id: number): Promise<void>;
  count(filter?: { source?: string }): Promise<number>;
  close(): Promise<void>;
}

let _instance: KnowledgeBase | null = null;

/**
 * Get the singleton KnowledgeBase instance. Reads `KB_BACKEND` env var
 * (default: `pgvector`) to pick the impl. Subsequent calls return the same
 * instance.
 */
export async function getKnowledgeBase(): Promise<KnowledgeBase> {
  if (_instance) return _instance;
  const backend = process.env.KB_BACKEND ?? 'pgvector';
  switch (backend) {
    case 'pgvector': {
      const { PgVectorKB } = await import('./pgvector.js');
      _instance = await PgVectorKB.create();
      return _instance;
    }
    default:
      throw new Error(`Unknown KB_BACKEND: ${backend}`);
  }
}

/**
 * Reset the singleton — for tests only. Closes the existing instance if any.
 */
export async function _resetKnowledgeBaseForTest(): Promise<void> {
  if (_instance) {
    await _instance.close();
    _instance = null;
  }
}
