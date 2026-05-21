/**
 * file-watcher — ignore-pattern coverage. Real chokidar is not exercised
 * here (it'd need a real fs); we only verify the predicate that decides
 * which paths to skip.
 */
import { describe, it, expect } from 'vitest';
import { shouldIgnore } from './file-watcher.js';

describe('shouldIgnore', () => {
  it('ignores node_modules', () => {
    expect(shouldIgnore('X:/repo/node_modules/foo/bar.js')).toBe(true);
    expect(shouldIgnore('X:\\repo\\node_modules\\pkg\\index.ts')).toBe(true);
  });
  it('ignores .git', () => {
    expect(shouldIgnore('X:/repo/.git/HEAD')).toBe(true);
  });
  it('ignores dist + build + target', () => {
    expect(shouldIgnore('X:/proj/dist/index.js')).toBe(true);
    expect(shouldIgnore('X:/proj/build/main.js')).toBe(true);
    expect(shouldIgnore('X:/proj/target/release.bin')).toBe(true);
  });
  it('ignores Recycle Bin + System Volume Information', () => {
    expect(shouldIgnore('X:/$RECYCLE.BIN/foo')).toBe(true);
    expect(shouldIgnore('X:/System Volume Information/log.bin')).toBe(true);
  });
  it('ignores PocketClawData (own data dir)', () => {
    expect(shouldIgnore('X:/PocketClawData/vault/wiki/foo.md')).toBe(true);
  });
  it('does NOT ignore typical user docs', () => {
    expect(shouldIgnore('X:/01 REPOSITORIES/pocketclaw/PRD.md')).toBe(false);
    expect(shouldIgnore('X:/00 DATA/notes/journal.md')).toBe(false);
  });
  it('does NOT ignore vault notes (they go through later extension filter)', () => {
    expect(shouldIgnore('X:/Documents/research.pdf')).toBe(false);
  });
  it('ignores OS junk files', () => {
    expect(shouldIgnore('X:/some/folder/.DS_Store')).toBe(true);
    expect(shouldIgnore('X:/some/folder/Thumbs.db')).toBe(true);
  });
});
