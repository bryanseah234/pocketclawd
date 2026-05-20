/**
 * PocketClaw — File auto-discovery (PRD §7.10)
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
 * The processed registry lives at `~/.pocketclaw/processed.db` (SQLite via
 * better-sqlite3, already in NanoClaw's deps).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import type { Fact } from './types.js';
import { stripHtml } from './types.js';

const WATCH_ROOT =
  process.env.WATCH_PATHS_ROOT ?? path.join(os.homedir(), '.pocketclaw', 'watch');
const PROCESSED_DB_PATH =
  process.env.POCKETCLAW_PROCESSED_DB ??
  path.join(os.homedir(), '.pocketclaw', 'processed.db');

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
  if (await registry.seen(file, hash)) return null;

  const text = await extractText(file);
  const chunks = chunkText(text);

  const facts: Fact[] = chunks.map((chunk, i) => ({
    text: chunk,
    source: `file:${path.relative(WATCH_ROOT, file).replace(/\\/g, '/')}`,
    sourceId: `${hash}#${i}`,
    occurredAt: new Date(),
    meta: { chunkIndex: i, fileExt: path.extname(file).toLowerCase() },
  }));

  await registry.mark(file, hash);
  return { facts };
}

/**
 * Watch a directory tree. New/modified files trigger `onFile`. Uses chokidar
 * (lazy import) so this file compiles before deps are installed.
 */
export async function watchDir(
  rootDir: string,
  onFile: (file: string) => Promise<void> | void,
): Promise<{ stop: () => Promise<void> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chokidar: any;
  try {
    chokidar = await import('chokidar');
  } catch {
    throw new Error('chokidar not installed. Run `pnpm install chokidar`.');
  }

  const watcher = chokidar.default.watch(rootDir, {
    ignored: /(^|[\\/])\../,
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
  });

  watcher.on('add', (file: string) => void onFile(file));
  watcher.on('change', (file: string) => void onFile(file));

  return {
    stop: () => watcher.close(),
  };
}

export const WATCH_PATHS_ROOT = WATCH_ROOT;
