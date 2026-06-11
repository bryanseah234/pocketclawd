#!/usr/bin/env node
/**
 * Node version guard (preinstall).
 *
 * This repo pins Node 22 (.nvmrc, Dockerfile = node:22.18.0-slim). The native
 * dep better-sqlite3@12 ships no prebuilt binary for Node 26 (ABI 147) and the
 * repo has no C++ toolchain assumption, so installing/testing under Node >= 23
 * silently breaks every DB-touching test with "Could not locate the bindings
 * file". Fail fast with actionable guidance instead.
 *
 * Honors engine-strict via .npmrc too; this script gives a clearer message and
 * also catches `pnpm install` paths where engine-strict alone is terse.
 */
const major = process.versions.node.split('.').map(Number)[0];
const WANT = 22;

if (major === WANT) {
  process.exit(0);
}

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

console.error('');
console.error(red(`  ✖ Wrong Node version: you are on Node ${process.versions.node}, this repo requires Node ${WANT}.x`));
console.error('');
console.error('  Why: better-sqlite3@12 has no prebuilt for Node ' + major + ' (ABI mismatch); tests + host will fail to load the DB binding.');
console.error('');
console.error(yellow('  Fix (pick one):'));
console.error('    nvm install 22 && nvm use 22        # nvm / nvm-windows');
console.error('    fnm use 22                          # fnm');
console.error('    volta pin node@22                   # volta');
console.error('  The pinned version lives in .nvmrc (22) and the prod image (node:22.18.0-slim).');
console.error('');
console.error('  To bypass intentionally (NOT recommended): set ALLOW_ANY_NODE=1');
console.error('');

if (process.env.ALLOW_ANY_NODE === '1') {
  console.error(yellow('  ALLOW_ANY_NODE=1 set — continuing anyway. You are on your own.'));
  process.exit(0);
}
process.exit(1);
