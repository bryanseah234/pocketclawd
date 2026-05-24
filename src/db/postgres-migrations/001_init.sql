-- Knowledge base schema (pgvector-backed)
-- Replaces the legacy mnemon Go binary + SQLite store.
-- Run automatically by src/db/postgres.ts on host startup.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;          -- fuzzy text search

CREATE TABLE IF NOT EXISTS insights (
  id            BIGSERIAL PRIMARY KEY,
  text          TEXT NOT NULL,
  embedding     vector(768),                     -- nomic-embed-text dimension (FIXED for HNSW indexability)
  embed_model   TEXT NOT NULL,                   -- e.g. 'nomic-embed-text' — forensic record + drift detection
  source        TEXT NOT NULL,                   -- 'telegram', 'whatsapp', 'gmail', 'photo', etc.
  source_id     TEXT,                            -- platform-specific id for dedup
  category      TEXT,
  importance    INTEGER DEFAULT 5,               -- 1-10
  entities      TEXT[] DEFAULT '{}',
  tags          TEXT[] DEFAULT '{}',
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source, source_id)                     -- idempotency guard
);

CREATE INDEX IF NOT EXISTS insights_embedding_idx ON insights
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS insights_source_idx     ON insights (source);
CREATE INDEX IF NOT EXISTS insights_created_idx    ON insights (created_at DESC);
CREATE INDEX IF NOT EXISTS insights_text_trgm_idx  ON insights USING gin (text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS insights_embed_model_idx ON insights (embed_model);

CREATE TABLE IF NOT EXISTS edges (
  from_id       BIGINT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  to_id         BIGINT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                   -- 'related', 'caused-by', 'about-same-entity', etc.
  weight        REAL DEFAULT 1.0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (from_id, to_id, kind)
);

CREATE INDEX IF NOT EXISTS edges_to_idx ON edges (to_id);
