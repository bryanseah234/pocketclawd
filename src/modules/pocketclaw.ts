/**
 * PocketClaw — runtime wiring (T16).
 *
 * Imported for side effects from `src/modules/index.ts`. On host startup:
 *   - Registers three scheduled jobs (02:00 ingest, 03:00 wiki, 07:00 digest)
 *   - Writes a `POCKETCLAW_START` audit-log line so we can confirm the
 *     module loaded.
 *
 * Cron uses `cron-parser` (already in package.json) for next-run calculation
 * and a single `setInterval` driver. This avoids depending on the agent-side
 * scheduler which lives inside containers.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CloudScheduler } from './ingestion/scheduler.js';
import { WikiGenerator } from './wiki-generator.js';
import { envPath } from './paths.js';

const LOG_PATH = envPath('LOG_PATH', 'logs');
const AUDIT_LOG = path.join(LOG_PATH, 'audit.log');

const SCHEDULES = [
  { name: 'cloud-ingest', cron: '0 2 * * *', handler: runCloudIngest },
  { name: 'wiki-regen', cron: '0 3 * * *', handler: runWikiRegen },
  { name: 'morning-digest', cron: '0 7 * * *', handler: runMorningDigest },
] as const;

const driverInterval = 60 * 1000; // poll every minute
let driverTimer: NodeJS.Timeout | null = null;
const lastRun = new Map<string, number>();

async function audit(line: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(AUDIT_LOG), { recursive: true });
    await fs.appendFile(
      AUDIT_LOG,
      `${new Date().toISOString()} | ${line}\n`,
      'utf8',
    );
  } catch {
    // best effort — audit log loss is acceptable in dev
  }
}

async function runCloudIngest(): Promise<void> {
  await audit('CRON | cloud-ingest START');
  try {
    const scheduler = new CloudScheduler();
    const summary = await scheduler.runAll();
    await audit(
      `CRON | cloud-ingest END | facts=${summary.totalFacts} errors=${summary.totalErrors} duration=${summary.finishedAt.getTime() - summary.startedAt.getTime()}ms`,
    );
  } catch (e) {
    await audit(`CRON | cloud-ingest FAIL | ${(e as Error).message}`);
  }
}

async function runWikiRegen(): Promise<void> {
  await audit('CRON | wiki-regen START');
  // Wiki generation needs a Claude provider — wired by the host at startup
  // via setWikiProvider(). If unset, skip and audit.
  if (!claudeCallback) {
    await audit('CRON | wiki-regen SKIP | no-provider');
    return;
  }
  try {
    const wiki = new WikiGenerator(claudeCallback);
    const result = await wiki.generateAll();
    await audit(
      `CRON | wiki-regen END | succeeded=${result.succeeded.length} failed=${result.failed.length}`,
    );
  } catch (e) {
    await audit(`CRON | wiki-regen FAIL | ${(e as Error).message}`);
  }
}

async function runMorningDigest(): Promise<void> {
  await audit('CRON | morning-digest START');
  // Morning digest is delivery-driven: it composes a message and pushes it
  // through NanoClaw's outbound channel for the pocketclaw group. Concrete
  // wiring is added by the runtime that owns delivery.ts; this stub keeps
  // the cron contract live and audited.
  if (!digestCallback) {
    await audit('CRON | morning-digest SKIP | no-handler');
    return;
  }
  try {
    await digestCallback();
    await audit('CRON | morning-digest END');
  } catch (e) {
    await audit(`CRON | morning-digest FAIL | ${(e as Error).message}`);
  }
}

let claudeCallback: ((prompt: string) => Promise<string>) | null = null;
let digestCallback: (() => Promise<void>) | null = null;

/** Wire a Claude callback so the wiki cron can render entries. */
export function setWikiProvider(fn: (prompt: string) => Promise<string>): void {
  claudeCallback = fn;
}

/** Wire a digest delivery handler. */
export function setDigestHandler(fn: () => Promise<void>): void {
  digestCallback = fn;
}

function nextRunFromCron(cron: string, now = new Date()): Date | null {
  // Minimal cron parser for the patterns we use: `M H * * *`.
  const match = cron.trim().match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/);
  if (!match) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

async function tick(): Promise<void> {
  const now = Date.now();
  for (const job of SCHEDULES) {
    const next = nextRunFromCron(job.cron, new Date(now));
    if (!next) continue;
    const last = lastRun.get(job.name) ?? 0;
    // Run if the scheduled time is within the last minute and we haven't
    // already run within the last 5 minutes.
    const sched = new Date(now);
    sched.setHours(next.getHours(), next.getMinutes(), 0, 0);
    if (sched.getTime() > now) {
      sched.setDate(sched.getDate() - 1); // most recent past occurrence
    }
    if (sched.getTime() > now - 60 * 1000 && now - last > 5 * 60 * 1000) {
      lastRun.set(job.name, now);
      void job.handler();
    }
  }
}

export function startPocketClawCron(): void {
  if (driverTimer) return;
  void audit('POCKETCLAW_START | cron driver running, jobs=cloud-ingest@02:00, wiki-regen@03:00, morning-digest@07:00');
  driverTimer = setInterval(() => void tick(), driverInterval);
}

export function stopPocketClawCron(): void {
  if (driverTimer) {
    clearInterval(driverTimer);
    driverTimer = null;
  }
}

// Self-register on import — same pattern as other modules in this folder.
startPocketClawCron();
