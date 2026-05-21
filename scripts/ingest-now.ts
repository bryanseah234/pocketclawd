/**
 * pnpm ingest:now — manual trigger that runs every cloud ingester once
 * and prints a summary. Useful for testing without waiting for the 02:00
 * cron, and for the `/ingest` slash command's underlying executor.
 *
 * Usage:
 *   pnpm ingest:now            # 24h window
 *   pnpm ingest:now --hours 1  # short window
 *   pnpm ingest:now --dry      # don't write to mnemon
 */

import { CloudScheduler } from '../src/modules/ingestion/scheduler.js';
import type { Fact } from '../src/modules/ingestion/types.js';

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const hours = Number(arg('hours', '24'));
const dry = flag('dry');
const since = new Date(Date.now() - hours * 60 * 60 * 1000);

const sched = new CloudScheduler();
let count = 0;
const onFact = dry
  ? (_f: Fact) => {
      count += 1;
    }
  : undefined;

console.log(`PocketClaw ingest — window ${hours}h, ${dry ? 'DRY-RUN (no mnemon writes)' : 'writes to mnemon'}`);
const t0 = Date.now();
const summary = await sched.runAll({ since, onFact });
const wall = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\nDone in ${wall}s — ${dry ? `${count} facts seen` : `${summary.totalFacts} facts written`}, ${summary.totalErrors} errors\n`);
for (const r of summary.results) {
  const tag = r.errors.length === 0 ? 'OK ' : 'ERR';
  console.log(
    `  [${tag}] ${r.source.padEnd(22)} facts=${String(r.factsCount).padEnd(4)} ${r.durationMs}ms`,
  );
  for (const e of r.errors.slice(0, 1)) {
    console.log(`        -> ${e.split('\n')[0].slice(0, 130)}`);
  }
}
