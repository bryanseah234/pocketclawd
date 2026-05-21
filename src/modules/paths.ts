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
