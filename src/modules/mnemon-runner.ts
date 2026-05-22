/**
 * PocketClaw — central mnemon spawn helper.
 *
 * mnemon (v0.1.6) is strictly a one-shot CLI — every invocation opens
 * `~/.mnemon/<store>.db` fresh, holds the SQLite lock for the duration of the
 * command, then exits. Under bursty load (Telegram backfill flooding chat
 * archive, plus a wiki recall, plus a digest cron firing) two `mnemon
 * remember` processes can race and the loser fails with:
 *
 *     insert insight: database is locked (5) (SQLITE_BUSY)
 *     open database: migrate: database is locked (5) (SQLITE_BUSY)
 *
 * Until upstream mnemon grows a `serve` subcommand we serialize all writes
 * through a single in-process async lock and transparently retry on
 * SQLITE_BUSY with exponential backoff. Reads (`recall`, `search`, `status`,
 * `related`, `log`) bypass the lock — they only race writers, and the
 * writer-side retry handles that.
 *
 * Every mnemon-spawning module in this codebase MUST go through `runMnemon`
 * (or `runMnemonJson`). Direct `spawn(mnemonBin(), ...)` calls reintroduce
 * the SQLITE_BUSY drop-on-the-floor bug.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { mnemonBin } from './paths.js';

/** Subcommands that take an exclusive write lock on the SQLite DB. */
const WRITE_SUBCOMMANDS = new Set([
  'remember',
  'forget',
  'link',
  'embed',
  'gc',
  'store', // `store create / use / delete` mutate the active-store registry
]);

export interface RunMnemonOptions {
  /** Override the input string piped to stdin (currently unused; reserved for future server mode). */
  stdin?: string;
  /** Hard timeout in ms. Defaults to 60s — mnemon ops are local SQLite, anything slower is wedged. */
  timeoutMs?: number;
  /** Maximum number of retries on SQLITE_BUSY. Default 5 (≈1.9s total backoff). */
  maxRetries?: number;
  /** Initial backoff in ms; doubled each attempt up to `maxBackoffMs`. Default 50. */
  initialBackoffMs?: number;
  /** Backoff cap in ms. Default 1000. */
  maxBackoffMs?: number;
}

export interface MnemonResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True if at least one BUSY retry was performed. */
  retried: boolean;
  attempts: number;
}

// Process-wide write serializer. Promises chain so writes are FIFO and never
// overlap. We deliberately keep this module-level (not exported) so test code
// can't accidentally bypass it.
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Spawn mnemon with `args`, returning stdout/stderr/exit code.
 *
 * If the first arg is a known write subcommand, the call is serialized
 * against every other write in this process and retried on SQLITE_BUSY.
 * Reads run concurrently but still retry on BUSY (cheap and correct).
 *
 * Never throws — even on spawn-error. Caller checks `code` / parses
 * `stdout` / handles `stderr`. This matches existing mnemon callers, which
 * are uniformly defensive.
 */
export function runMnemon(
  args: readonly string[],
  opts: RunMnemonOptions = {},
): Promise<MnemonResult> {
  const isWrite = args.length > 0 && WRITE_SUBCOMMANDS.has(String(args[0]));
  const job = () => runMnemonOnce(args, opts);

  if (!isWrite) return job();

  // Serialize: append to the shared chain. We swallow errors on the chain
  // itself so one failed write can't poison the rest.
  const next = writeChain.then(job, job);
  writeChain = next.catch(() => undefined);
  return next;
}

/**
 * Convenience: run mnemon, parse stdout as JSON, return `null` on
 * non-zero exit or parse failure. Used by recall / status / search readers
 * that all consume mnemon's `--format json` output.
 */
export async function runMnemonJson<T = unknown>(
  args: readonly string[],
  opts: RunMnemonOptions = {},
): Promise<{ data: T | null; result: MnemonResult }> {
  const result = await runMnemon(args, opts);
  if (result.code !== 0 || !result.stdout) return { data: null, result };
  try {
    return { data: JSON.parse(result.stdout) as T, result };
  } catch {
    return { data: null, result };
  }
}

async function runMnemonOnce(
  args: readonly string[],
  opts: RunMnemonOptions,
): Promise<MnemonResult> {
  const maxRetries = opts.maxRetries ?? 5;
  const initialBackoff = opts.initialBackoffMs ?? 50;
  const maxBackoff = opts.maxBackoffMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  let attempt = 0;
  let last: MnemonResult = { code: -1, stdout: '', stderr: '', retried: false, attempts: 0 };

  while (attempt <= maxRetries) {
    attempt += 1;
    const r = await spawnMnemon(args, opts.stdin, timeoutMs);
    last = { ...r, retried: attempt > 1, attempts: attempt };

    if (r.code === 0) return last;

    if (!isBusy(r.stderr) || attempt > maxRetries) {
      return last;
    }

    const backoff = Math.min(initialBackoff * 2 ** (attempt - 1), maxBackoff);
    await sleep(backoff);
  }

  return last;
}

function spawnMnemon(
  args: readonly string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const stdio: SpawnOptions['stdio'] = [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'];
    const proc = spawn(mnemonBin(), args as string[], { stdio });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr });
    };

    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
      stderr += `\n[mnemon-runner] killed after ${timeoutMs}ms timeout`;
      settle(124);
    }, timeoutMs);

    proc.stdout?.on('data', (c) => (stdout += String(c)));
    proc.stderr?.on('data', (c) => (stderr += String(c)));
    proc.on('error', (err) => {
      stderr += `\n[mnemon-runner] spawn error: ${err.message}`;
      settle(-1);
    });
    proc.on('exit', (code) => settle(code ?? -1));

    if (stdin !== undefined && proc.stdin) {
      proc.stdin.end(stdin);
    }
  });
}

/**
 * Detect SQLITE_BUSY in mnemon stderr. mnemon emits these verbatim:
 *   - "database is locked (5) (SQLITE_BUSY)"
 *   - "insert insight: database is locked (5)"
 *   - "open database: migrate: database is locked (5) (SQLITE_BUSY)"
 *
 * We match loosely on "database is locked" + "(5)" so we don't over-match
 * unrelated SQLite errors.
 */
function isBusy(stderr: string): boolean {
  if (!stderr) return false;
  const s = stderr.toLowerCase();
  return s.includes('database is locked') && (s.includes('(5)') || s.includes('sqlite_busy'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test-only: drain the write chain. Lets tests await all in-flight writes
// before assertions. NOT for production use.
export function _drainWritesForTest(): Promise<unknown> {
  return writeChain;
}
