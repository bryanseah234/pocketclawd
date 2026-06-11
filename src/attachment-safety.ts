import path from 'path';

/**
 * Is `name` safe to use as the last segment of a path inside an
 * attachment-staging directory? Filenames originate from untrusted sources —
 * channel messages from any chat participant, agent-to-agent forwards from
 * a possibly-compromised peer agent — and land in `path.join(dir, name)`
 * sinks on the host. Without this guard, a `..`-laden name escapes the
 * inbox and writes anywhere the host process has filesystem permission.
 *
 * Rejects:
 *   - non-string / empty
 *   - `.` / `..` (traversal sentinels that path.basename returns as-is)
 *   - anything containing a path separator (`/` or `\`) or NUL
 *   - any value where `path.basename(name) !== name`, catching OS-specific
 *     separators and covering drives/prefixes on Windows runtimes
 */
export function isSafeAttachmentName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/\0]/.test(name)) return false;
  return path.basename(name) === name;
}
/**
 * Map a name that has already passed `isSafeAttachmentName` (no separators,
 * no traversal sentinels) into a string that's also valid as the last
 * segment of a path on every OS we run on.
 *
 * Why this exists: messageIds carry colons (e.g. `154320684:60:ag-...`)
 * which are fine on Linux/macOS but illegal on Windows (NTFS alternate
 * data stream delimiter). `mkdirSync` fails with ENOENT — *not* EINVAL —
 * because Windows tries to interpret `inbox\foo:bar` as the stream `bar`
 * on file `foo` and "no such file" surfaces. That used to silently drop
 * every photo DM on the Windows host.
 *
 * Replaces every character in `<>:"/\|?*` and every control char (0x00-0x1F)
 * with `-`. Preserves length and uniqueness across distinct inputs that
 * differ only in safe characters — collisions are still possible if two
 * distinct messageIds map to the same sanitized form, but for our purposes
 * (one mkdir per messageId) that's acceptable: a collision means the
 * `wx` flag refuses the second write, which logs and continues.
 *
 * Caller is responsible for calling `isSafeAttachmentName` first — this
 * function is a Windows-compat layer, not a security boundary.
 */
export function sanitizeForFilesystem(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-');
}
