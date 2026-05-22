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
  /**
   * Hard timeout in ms. Defaults to 15s. Steady-state mnemon ops complete in
   * ~200ms (max ~500ms under burst), so 15s is 30× headroom; anything slower
   * is wedged and we want to surface it fast rather than block the writer
   * queue. Timeouts are retried like SQLITE_BUSY (see runMnemonOnce).
   */
  timeoutMs?: number;
  /**
   * Maximum number of retries on retryable failures (SQLITE_BUSY *or* hard
   * timeout). Default 5 (≈1.9s total backoff).
   */
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
  /** True if at least one retry (BUSY or timeout) was performed. */
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
  const timeoutMs = opts.timeoutMs ?? 15_000;

  let attempt = 0;
  let last: MnemonResult = { code: -1, stdout: '', stderr: '', retried: false, attempts: 0 };

  while (attempt <= maxRetries) {
    attempt += 1;
    const r = await spawnMnemon(args, opts.stdin, timeoutMs);
    last = { ...r, retried: attempt > 1, attempts: attempt };

    if (r.code === 0) return last;

    const busy = isBusy(r.stderr);
    const timedOut = isTimeout(r.stderr);
    const retryable = busy || timedOut;

    if (!retryable || attempt > maxRetries) {
      // Only warn on retry-exhaustion of a known retryable cause; stay silent
      // on unrelated non-zero exits so the runner doesn't spam logs.
      if (retryable) {
        const reason = busy ? 'BUSY' : 'TIMEOUT';
        // eslint-disable-next-line no-console
        console.warn(
          `[mnemon-runner] ${reason} retries exhausted attempts=${attempt} args=${sanitizeArgs(args)} stderr=${snippet(r.stderr)}`,
        );
      }
      return last;
    }

    const reason = busy ? 'BUSY' : 'TIMEOUT';
    // eslint-disable-next-line no-console
    console.warn(
      `[mnemon-runner] ${reason} retry attempt=${attempt}/${maxRetries} args=${sanitizeArgs(args)} stderr=${snippet(r.stderr)}`,
    );

    const backoff = Math.min(initialBackoff * 2 ** (attempt - 1), maxBackoff);
    await sleep(backoff);
  }

  return last;
}

/**
 * Strip mnemon argv down to just the subcommand and flag NAMES — never
 * flag values. Prevents log lines from leaking message bodies / API tokens
 * / personally identifying content from `--content`, `--auth`, etc.
 */
function sanitizeArgs(args: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (i === 0) {
      // Subcommand (e.g. "remember").
      out.push(a);
      continue;
    }
    if (a.startsWith('--') || a.startsWith('-')) {
      // Flag name. If it's `--flag=value`, keep just `--flag`.
      const eq = a.indexOf('=');
      out.push(eq === -1 ? a : a.slice(0, eq));
      // Skip the next token if it's the value of this flag (no leading dash).
      if (eq === -1 && i + 1 < args.length && !String(args[i + 1]).startsWith('-')) {
        i += 1;
      }
    }
    // Bare positionals are also dropped (could be content).
  }
  return out.join(' ');
}

/** Compress stderr to a single-line ≤120-char snippet for log readability. */
function snippet(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
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

/**
 * Detect a hard-timeout kill from spawnMnemon. We append the literal marker
 * `[mnemon-runner] killed after <N>ms timeout` to stderr inside the kill
 * timer; that's the canonical signal a wedge happened. A wedge under sustained
 * load is itself a contention symptom — same retry policy as BUSY applies.
 */
function isTimeout(stderr: string): boolean {
  if (!stderr) return false;
  return stderr.includes('[mnemon-runner] killed after ') && stderr.includes('ms timeout');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test-only: drain the write chain. Lets tests await all in-flight writes
// before assertions. NOT for production use.
export function _drainWritesForTest(): Promise<unknown> {
  return writeChain;
}
