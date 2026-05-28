/* eslint-disable */
/**
 * Clawd — File auto-discovery (PRD §7.10)
 *
 * Watches paths under `WATCH_PATHS_ROOT` for new/modified files. Each file
 * is fingerprinted (SHA256) and processed exactly once per content version.
 * Re-saving the same file is a no-op; modifying it triggers re-ingestion.
 *
 * Supported formats:
 *   .md  .txt  → raw read
 *   .docx      → mammoth (lazy)
 *   .pptx      → pptx-text-extract (lazy)
 *   .pdf       → pdf-parse (lazy)
 *   .eml       → email stdlib (Node mailparser, lazy)
 *   .vcf       → vCard regex
 *   .ics       → iCal regex
 *
 * The processed registry lives at `~/.clawd/processed.db` (SQLite via
 * better-sqlite3, already in NanoClaw's deps).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Fact } from './types.js';
import { stripHtml } from './types.js';
import { envPath, expandHome } from '../paths.js';

const WATCH_ROOT = envPath('WATCH_PATHS_ROOT', 'watch');
const PROCESSED_DB_PATH = process.env.CLAWD_PROCESSED_DB
  ? expandHome(process.env.CLAWD_PROCESSED_DB)
  : envPath('CLAWD_PROCESSED_DB', 'processed.db');

/** SHA256 of the file's bytes — content fingerprint. */
export async function sha256(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Idempotent registry: stores (path, sha256, processedAt). On second pass
 * with the same hash, `seen()` returns true → skip.
 */
export class ProcessedRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private seenStmt: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private markStmt: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private claimStmt: any = null;

  async ensure(): Promise<void> {
    if (this.db) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let Database: any;
    try {
      Database = (await import('better-sqlite3')).default;
    } catch {
      throw new Error(
        'better-sqlite3 not installed. NanoClaw deps must be installed first.',
      );
    }
    await fs.mkdir(path.dirname(PROCESSED_DB_PATH), { recursive: true });
    this.db = new Database(PROCESSED_DB_PATH);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed (
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        processed_at INTEGER NOT NULL,
        PRIMARY KEY (path, sha256)
      );
    `);
    this.seenStmt = this.db.prepare(
      `SELECT 1 FROM processed WHERE path = ? AND sha256 = ?`,
    );
    this.markStmt = this.db.prepare(
      `INSERT OR REPLACE INTO processed (path, sha256, processed_at) VALUES (?, ?, ?)`,
    );
  }

  async seen(file: string, hash: string): Promise<boolean> {
    await this.ensure();
    return Boolean(this.seenStmt.get(file, hash));
  }

  async mark(file: string, hash: string): Promise<void> {
    await this.ensure();
    this.markStmt.run(file, hash, Date.now());
  }

  /**
   * Atomically claim a (file, hash) for processing. Returns true if THIS
   * caller is the one that gets to process the file; false if another
   * caller already claimed it.
   *
   * Rationale: chokidar can fire multiple `add`/`change` events for the
   * same path in quick succession (e.g. when a file is rewritten by
   * Office). Without atomic claim, two concurrent processFile() calls
   * both see seen()=false, both compute embeddings, both write to mnemon
   * → duplicate facts. INSERT OR IGNORE on the (path, sha256) primary
   * key resolves the race in SQLite's writer lock.
   */
  async claim(file: string, hash: string): Promise<boolean> {
    await this.ensure();
    if (!this.claimStmt) {
      this.claimStmt = this.db.prepare(
        `INSERT OR IGNORE INTO processed (path, sha256, processed_at) VALUES (?, ?, ?)`,
      );
    }
    const result = this.claimStmt.run(file, hash, Date.now());
    return result.changes > 0;
  }
}

/** Extract plain text from a single file based on its extension. */
export async function extractText(file: string): Promise<string> {
  const ext = path.extname(file).toLowerCase();

  if (ext === '.md' || ext === '.txt') {
    return fs.readFile(file, 'utf8');
  }

  if (ext === '.docx') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mammoth: any;
    try {
      mammoth = await import('mammoth');
    } catch {
      throw new Error('mammoth not installed. Run `pnpm install mammoth`.');
    }
    const result = await mammoth.extractRawText({ path: file });
    return String(result.value ?? '');
  }

  if (ext === '.pdf') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pdfParse: any;
    try {
      // @ts-ignore — pdf-parse has no types shipped
      pdfParse = (await import('pdf-parse')).default;
    } catch {
      throw new Error('pdf-parse not installed. Run `pnpm install pdf-parse`.');
    }
    const buf = await fs.readFile(file);
    const out = await pdfParse(buf);
    return String(out.text ?? '');
  }

  if (ext === '.pptx') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let extract: any;
    try {
      // @ts-ignore — pptx-text-parser is optional and has no types
      extract = (await import('pptx-text-parser')).default;
    } catch {
      // Fall back to nothing — pptx is rare; log + skip gracefully.
      return '';
    }
    return String(await extract(file));
  }

  if (ext === '.eml') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mailparser: any;
    try {
      // @ts-ignore — mailparser has runtime types via separate package
      mailparser = await import('mailparser');
    } catch {
      // fall back: read raw, strip headers crudely
      const raw = await fs.readFile(file, 'utf8');
      const bodyStart = raw.indexOf('\n\n');
      return stripHtml(raw.slice(bodyStart === -1 ? 0 : bodyStart));
    }
    const buf = await fs.readFile(file);
    const parsed = await mailparser.simpleParser(buf);
    return [
      `From: ${parsed.from?.text ?? ''}`,
      `Subject: ${parsed.subject ?? ''}`,
      `Date: ${parsed.date?.toISOString() ?? ''}`,
      '',
      stripHtml(parsed.text ?? parsed.html ?? ''),
    ].join('\n');
  }

  if (ext === '.vcf' || ext === '.ics') {
    return fs.readFile(file, 'utf8');
  }

  return '';
}

/** Chunk text into ~512-token windows with 64-token overlap. */
export function chunkText(text: string, size = 512, overlap = 64): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += size - overlap) {
    const slice = words.slice(i, i + size).join(' ');
    if (slice) chunks.push(slice);
    if (i + size >= words.length) break;
  }
  return chunks;
}

/**
 * Process a single file end-to-end. Returns:
 *   - `null` if already processed (idempotency hit)
 *   - `{ facts: [] }` if extracted but produced no chunks
 *   - `{ facts: Fact[] }` otherwise
 */
export async function processFile(
  file: string,
  registry: ProcessedRegistry,
): Promise<{ facts: Fact[] } | null> {
  const hash = await sha256(file);
  // Atomic: only one caller processes this (file, hash). The row is
  // inserted up-front so concurrent chokidar fires for the same path
  // collapse into one processed batch.
  const won = await registry.claim(file, hash);
  if (!won) return null;

  try {
    const text = await extractText(file);
    const chunks = chunkText(text);

    const facts: Fact[] = chunks.map((chunk, i) => ({
      text: chunk,
      source: `file:${path.relative(WATCH_ROOT, file).replace(/\\/g, '/')}`,
      sourceId: `${hash}#${i}`,
      occurredAt: new Date(),
      meta: { chunkIndex: i, fileExt: path.extname(file).toLowerCase() },
    }));

    return { facts };
  } catch (err) {
    // Extraction failed (corrupt PDF, missing optional dep, etc.). Leaving
    // the claim in place would make the file effectively un-ingestable
    // until its bytes change. Roll back so the next watch event retries.
    // We tolerate the small duplicate-work window in exchange for not
    // permanently shadowing legitimate content.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (registry as any).db;
      if (db) {
        db.prepare('DELETE FROM processed WHERE path = ? AND sha256 = ?').run(file, hash);
      }
    } catch {
      /* best-effort rollback */
    }
    throw err;
  }
}

/**
 * Watch a directory tree. New/modified files trigger `onFile`. Uses chokidar
 * (lazy import) so this file compiles before deps are installed.
 *
 * Smart exclusions are baked in for whole-drive watch scenarios (e.g.
 * `WATCH_PATHS_ROOT=X:/` to ingest your whole repo+docs drive without
 * indexing 50 GB of node_modules).
 */
const DEFAULT_IGNORES: RegExp[] = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])\.svn([\\/]|$)/,
  /(^|[\\/])\.hg([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.venv([\\/]|$)/,
  /(^|[\\/])venv([\\/]|$)/,
  /(^|[\\/])__pycache__([\\/]|$)/,
  /(^|[\\/])\.pytest_cache([\\/]|$)/,
  /(^|[\\/])\.mypy_cache([\\/]|$)/,
  /(^|[\\/])\.ruff_cache([\\/]|$)/,
  /(^|[\\/])\.next([\\/]|$)/,
  /(^|[\\/])\.nuxt([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
  /(^|[\\/])\.parcel-cache([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  /(^|[\\/])build([\\/]|$)/,
  /(^|[\\/])out([\\/]|$)/,
  /(^|[\\/])target([\\/]|$)/,
  /(^|[\\/])bin([\\/]|$)/,
  /(^|[\\/])obj([\\/]|$)/,
  /(^|[\\/])\.idea([\\/]|$)/,
  /(^|[\\/])\.vscode([\\/]|$)/,
  /(^|[\\/])coverage([\\/]|$)/,
  /(^|[\\/])\.nyc_output([\\/]|$)/,
  /(^|[\\/])\.turbo([\\/]|$)/,
  /(^|[\\/])\.gradle([\\/]|$)/,
  /(^|[\\/])\.terraform([\\/]|$)/,
  /(^|[\\/])\.bundle([\\/]|$)/,
  /(^|[\\/])\$RECYCLE\.BIN([\\/]|$)/,
  /(^|[\\/])System Volume Information([\\/]|$)/,
  /(^|[\\/])ClawdData([\\/]|$)/,    // don't ingest our own data dir
  /(^|[\\/])tmp([\\/]|$)/,
  /(^|[\\/])temp([\\/]|$)/,
  /(^|[\\/])\.tmp([\\/]|$)/,
  /(^|[\\/])\.DS_Store$/,
  /(^|[\\/])Thumbs\.db$/,
];

const SUPPORTED_EXTENSIONS = new Set([
  '.md', '.txt', '.docx', '.pdf', '.pptx', '.eml', '.vcf', '.ics',
]);

/**
 * Should this path be ignored? Centralized so chokidar's `ignored` filter
 * and our extension allowlist agree.
 */
export function shouldIgnore(p: string): boolean {
  for (const re of DEFAULT_IGNORES) {
    if (re.test(p)) return true;
  }
  return false;
}

/**
 * Whole-drive roots (e.g. `X:/`, `C:\\`) recurse into thousands of
 * directories on Windows, where chokidar allocates one FSEventWrap PER
 * directory. With our previous `depth: 99` default that produced a
 * runaway handle leak (60+ FSWatchers/sec, 7000+ in 90s). The host
 * eventually wedges with tens of thousands of libuv handles.
 *
 * Defence in depth:
 *   1. Reject bare drive roots unless `CLAWD_WATCH_DRIVE_ROOT=true`.
 *   2. Bound recursion via `CLAWD_WATCH_DEPTH` (default 8 — was 99).
 *   3. Hard cap watcher count via `CLAWD_WATCH_MAX_DIRS`
 *      (default 2000); when the underlying handle count crosses the cap
 *      we close the watcher and log loudly. Better to lose ingestion on
 *      one root than wedge the whole host.
 */
function isDriveRoot(p: string): boolean {
  // Windows: 'X:/', 'X:\\', 'X:'  |  POSIX: '/'
  const norm = p.replace(/\\/g, '/');
  if (norm === '/') return true;
  return /^[A-Za-z]:\/?$/.test(norm);
}

export async function watchDir(
  rootDir: string,
  onFile: (file: string) => Promise<void> | void,
): Promise<{ stop: () => Promise<void> }> {
  if (isDriveRoot(rootDir) && process.env.CLAWD_WATCH_DRIVE_ROOT !== 'true') {
    throw new Error(
      `[file-watcher] refusing to watch drive root ${rootDir}: chokidar opens one FSEventWrap per directory and will exhaust libuv handles on a multi-TB drive. Set CLAWD_WATCH_DRIVE_ROOT=true to override, or scope WATCH_PATHS_ROOT to a specific folder.`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chokidar: any;
  try {
    chokidar = await import('chokidar');
  } catch {
    throw new Error('chokidar not installed. Run `pnpm install chokidar`.');
  }

  const ignored = (p: string): boolean => {
    if (shouldIgnore(p)) return true;
    // For files (have extension), only allow our supported set; for dirs
    // (no extension after path.extname), pass through so chokidar can recurse.
    const ext = path.extname(p).toLowerCase();
    if (ext) return !SUPPORTED_EXTENSIONS.has(ext);
    return false;
  };

  const depth = Number(process.env.CLAWD_WATCH_DEPTH ?? 8);
  const maxDirs = Number(process.env.CLAWD_WATCH_MAX_DIRS ?? 2000);

  const watcher = chokidar.default.watch(rootDir, {
    ignored,
    persistent: true,
    // Default: don't ingest the initial snapshot — only react to NEW changes
    // from now on. Override with CLAWD_WATCH_INITIAL=true if you want
    // to bulk-ingest the existing tree (warning: 50k+ files possible on
    // an X:\\ drive).
    ignoreInitial: process.env.CLAWD_WATCH_INITIAL !== 'true',
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
    // Bounded recursion — see file-header notes about handle leak.
    depth: Number.isFinite(depth) && depth > 0 ? depth : 8,
    usePolling: false,
    alwaysStat: false,
  });

  watcher.on('add', (file: string) => void onFile(file));
  watcher.on('change', (file: string) => void onFile(file));

  // Hard cap: poll the watched-paths object every 5s. If it crosses
  // the threshold close the watcher to bound libuv handle growth.
  let dirCount = 0;
  let capped = false;
  const interval = setInterval(() => {
    try {
      const watched = watcher.getWatched?.() as Record<string, string[]> | undefined;
      if (!watched) return;
      dirCount = Object.keys(watched).length;
      if (!capped && dirCount > maxDirs) {
        capped = true;
        // eslint-disable-next-line no-console
        console.error(
          `[file-watcher] CAP TRIPPED for ${rootDir}: ${dirCount} watched dirs > ${maxDirs}. ` +
            `Closing watcher to prevent handle exhaustion. Lower scope or raise CLAWD_WATCH_MAX_DIRS.`,
        );
        void watcher.close();
        clearInterval(interval);
      }
    } catch {
      /* ignore — best-effort monitoring */
    }
  }, 5000);
  // Don't keep the event loop alive just for the monitor.
  if (typeof interval.unref === 'function') interval.unref();

  return {
    stop: async () => {
      clearInterval(interval);
      await watcher.close();
    },
  };
}

/**
 * Watch ALL configured roots. Comma-separated `WATCH_PATHS_ROOT` lets you
 * point at multiple drives or trees. Each root gets its own chokidar
 * watcher.
 */
export async function watchAllConfiguredRoots(
  onFile: (file: string) => Promise<void> | void,
): Promise<{ stop: () => Promise<void> }> {
  const raw = process.env.WATCH_PATHS_ROOT ?? '';
  const roots = raw.split(',').map((r) => expandHome(r.trim())).filter(Boolean);
  if (roots.length === 0) roots.push(WATCH_ROOT);

  const watchers: Array<{ stop: () => Promise<void> }> = [];
  for (const r of roots) {
    try {
      const w = await watchDir(r, onFile);
      watchers.push(w);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[file-watcher] failed to watch ${r}:`, (err as Error).message);
    }
  }
  return {
    stop: async () => {
      await Promise.allSettled(watchers.map((w) => w.stop()));
    },
  };
}

export const WATCH_PATHS_ROOT = WATCH_ROOT;
