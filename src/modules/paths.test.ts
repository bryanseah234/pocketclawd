/**
 * paths.ts — tilde expansion + envPath.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { expandHome, envPath } from './paths.js';

describe('expandHome', () => {
  it('expands lone ~', () => {
    expect(expandHome('~')).toBe(os.homedir());
  });
  it('expands ~/ prefix', () => {
    expect(expandHome('~/foo')).toBe(path.join(os.homedir(), 'foo'));
  });
  it('expands ~\\ prefix on Windows-style paths', () => {
    expect(expandHome('~\\bar')).toBe(path.join(os.homedir(), 'bar'));
  });
  it('passes through absolute paths', () => {
    expect(expandHome('X:/data')).toBe('X:/data');
    expect(expandHome('/etc/passwd')).toBe('/etc/passwd');
  });
  it('passes through paths with ~ in the middle (not at start)', () => {
    expect(expandHome('/path/with~tilde')).toBe('/path/with~tilde');
  });
  it('handles empty string', () => {
    expect(expandHome('')).toBe('');
  });
});

describe('envPath', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.MY_TEST_PATH_VAR;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MY_TEST_PATH_VAR;
    else process.env.MY_TEST_PATH_VAR = prev;
  });

  it('returns expanded env var when set', () => {
    process.env.MY_TEST_PATH_VAR = '~/configured';
    expect(envPath('MY_TEST_PATH_VAR', 'fallback')).toBe(path.join(os.homedir(), 'configured'));
  });

  it('returns ~/.pocketclaw/<defaultSubdir> when env var unset', () => {
    delete process.env.MY_TEST_PATH_VAR;
    expect(envPath('MY_TEST_PATH_VAR', 'subdir')).toBe(
      path.join(os.homedir(), '.pocketclaw', 'subdir'),
    );
  });

  it('returns default when env var is empty string', () => {
    process.env.MY_TEST_PATH_VAR = '';
    expect(envPath('MY_TEST_PATH_VAR', 'sub')).toBe(
      path.join(os.homedir(), '.pocketclaw', 'sub'),
    );
  });
});
