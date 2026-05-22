/**
 * PocketClaw — shared path helpers.
 *
 * Keeps tilde-expansion in one place so every module that reads a path
 * env-var (`VAULT_PATH`, `MNEMON_DB_PATH`, `WATCH_PATHS_ROOT`, `LOG_PATH`)
 * resolves `~` to the user's home directory.
 *
 * Node does NOT expand `~` automatically — `~/.pocketclaw` is treated as
 * a literal directory called `~` inside the cwd, which is what bit us
 * during the §17 smoke test (files landed in `<repo>/~/.pocketclaw/`).
 */

import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Expand a leading `~` or `~/...` to the user's home directory.
 * Pass-through for absolute paths and any path not starting with `~`.
 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Read an env-var path with home-expansion + a default that lives inside
 * `~/.pocketclaw/`. Use this for any user-facing path config.
 */
export function envPath(envVar: string, defaultSubdir: string): string {
  const raw = process.env[envVar];
  if (raw && raw.length > 0) return expandHome(raw);
  return path.join(os.homedir(), '.pocketclaw', defaultSubdir);
}

/**
 * Resolve the absolute path to the `mnemon` binary.
 *
 * Why this matters: when NanoClaw runs as a Windows Scheduled Task under
 * NT AUTHORITY\SYSTEM, the SYSTEM PATH does NOT include user-specific
 * bin directories like `C:\Users\<user>\go\bin`, so `spawn('mnemon', ...)`
 * fails with ENOENT and every chat-archive / wiki / digest write disappears
 * silently. We resolve the binary explicitly here.
 *
 * Resolution order:
 *   1. `MNEMON_BIN` env-var (if set + exists) — explicit override.
 *   2. Bare `mnemon` (works when the host is run from an interactive shell
 *      whose PATH includes the install dir).
 *
 * Returns whatever string is appropriate for `child_process.spawn`. Callers
 * MUST pass it as the first argument; further-resolution / shell quoting is
 * handled by Node.
 */
export function mnemonBin(): string {
  const explicit = process.env.MNEMON_BIN;
  if (explicit && explicit.length > 0) return expandHome(explicit);
  return 'mnemon';
}
