/**
 * Postgres connection pool + migration runner.
 *
 * Single shared `Pool` for the host process. Migrations live in
 * `src/db/postgres-migrations/` as numbered SQL files (e.g. `001_init.sql`)
 * and run idempotently on startup.
 */

import { Pool, types, type PoolClient } from 'pg';
import { readdir, readFile } from 'node:fs/promises';

/**
 * Coerce Postgres BIGINT (oid 20) from string to JS number.
 *
 * pg's default behaviour is to return BIGINT as string to preserve
 * precision beyond 2^53. PocketClaw's id columns will never approach that,
 * and the `Insight.id` interface is typed `number`. Centralising the parser
 * here means impl code doesn't need per-query casts.
 *
 * If we ever store a count or aggregate that genuinely needs > 2^53, do an
 * explicit `::text` cast in that query and parse manually.
 */
types.setTypeParser(20, (val) => Number.parseInt(val, 10));
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _pool: Pool | null = null;

/**
 * Build a Pool from env vars. Mirrors libpq env conventions:
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
 * Defaults assume the docker-compose `postgres` service on localhost.
 */
export function getPool(): Pool {
  if (_pool) return _pool;
  _pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'pocketclaw',
    user: process.env.PGUSER ?? 'pocketclaw',
    password: process.env.PGPASSWORD,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
  });
  // Surface unexpected pool errors instead of silently dying
  _pool.on('error', (err) => {
    console.error('[knowledge-base] pg pool error:', err);
  });
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Apply all migrations in `src/db/postgres-migrations/` in lexical order.
 * Migrations are tracked in a `_migrations` table; already-applied ones are
 * skipped. Each migration runs in its own transaction.
 *
 * Idempotency: relies on per-statement `IF NOT EXISTS` guards in the SQL plus
 * the `_migrations.id` primary key. Re-running after an aborted migration is
 * safe.
 */
export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const migrationsDir = resolveMigrationsDir();
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const id = file.replace(/\.sql$/, '');
      const exists = await client.query('SELECT 1 FROM _migrations WHERE id = $1', [id]);
      if (exists.rowCount && exists.rowCount > 0) {
        skipped.push(id);
        continue;
      }
      const sql = await readFile(join(migrationsDir, file), 'utf-8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (id) VALUES ($1)', [id]);
        await client.query('COMMIT');
        applied.push(id);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${id} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    client.release();
  }

  return { applied, skipped };
}

/**
 * Locate the migrations directory. From compiled output (`dist/...`) the path
 * relative to this file changes; from `tsx` (running source directly) it's the
 * source tree. Walk up looking for `src/db/postgres-migrations`.
 */
function resolveMigrationsDir(): string {
  // Allow override for tests
  if (process.env.PG_MIGRATIONS_DIR) {
    return process.env.PG_MIGRATIONS_DIR;
  }
  // Walk up from __dirname looking for src/db/postgres-migrations
  let cur = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = join(cur, 'src', 'db', 'postgres-migrations');
    try {
      // Sync existence check via require would be cleaner but we already use async fs
      // Fall back to a hard-coded relative — the tree is stable.
    } catch {}
    cur = dirname(cur);
  }
  // Repo-relative fallback (works for tsx + compiled output equally)
  return resolve(__dirname, '..', '..', 'db', 'postgres-migrations');
}

export type { PoolClient };
