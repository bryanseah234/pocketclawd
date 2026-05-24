/**
 * Embedding generator — calls a local Ollama instance.
 *
 * Default model is `nomic-embed-text` (768-dim). Override via
 * `OLLAMA_EMBED_MODEL` env var. The dimension MUST match the schema
 * (`vector(768)` in 001_init.sql) — if you swap to a 1024-dim model, you
 * also need to ALTER TABLE the `embedding` column and re-embed all rows.
 *
 * Returns the embedding vector AND the model name used, so callers can
 * record `embed_model` per row for forensic clarity.
 */

const DEFAULT_HOST = 'http://localhost:11434';
const DEFAULT_MODEL = 'nomic-embed-text';
const EXPECTED_DIM = 768;

export interface Embedding {
  vector: number[];
  model: string;
}

export async function embed(text: string): Promise<Embedding> {
  const host = process.env.OLLAMA_HOST ?? DEFAULT_HOST;
  const model = process.env.OLLAMA_EMBED_MODEL ?? DEFAULT_MODEL;

  const response = await fetch(`${host}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Ollama embeddings call failed: ${response.status} ${response.statusText} ${body}`,
    );
  }

  const data = (await response.json()) as { embedding?: number[] };
  if (!data.embedding || !Array.isArray(data.embedding)) {
    throw new Error('Ollama embeddings response missing `embedding` array');
  }

  if (data.embedding.length !== EXPECTED_DIM) {
    throw new Error(
      `Embedding dimension mismatch: got ${data.embedding.length}, expected ${EXPECTED_DIM}. ` +
        `Schema is vector(${EXPECTED_DIM}) — either change OLLAMA_EMBED_MODEL back to a ${EXPECTED_DIM}-dim model ` +
        `or run a schema migration to switch dimensions and re-embed all rows.`,
    );
  }

  return { vector: data.embedding, model };
}

/**
 * Format a float[] as a pgvector literal: '[0.1,0.2,...]'.
 * pgvector accepts this shape directly in INSERT/UPDATE.
 */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}
