/**
 * Clawd — runtime wiring (T16).
 *
 * Imported for side effects from `src/modules/index.ts`. On host startup:
 *   - Registers three scheduled jobs (02:00 ingest, 03:00 wiki, 07:00 digest)
 *   - Writes a `CLAWD_START` audit-log line so we can confirm the
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
import { getKnowledgeBase } from './knowledge-base/index.js';
import {
  watchAllConfiguredRoots,
  ProcessedRegistry,
  processFile,
} from './ingestion/file-watcher.js';
import { startTelegramMtprotoIngester } from './ingestion/telegram-mtproto.js';

const LOG_PATH = envPath('LOG_PATH', 'logs');
const AUDIT_LOG = path.join(LOG_PATH, 'audit.log');

const SCHEDULES = [
  { name: 'cloud-ingest', cron: '0 2 * * *', handler: runCloudIngest },
  { name: 'wiki-regen', cron: '0 3 * * *', handler: runWikiRegen },
  // mnemon gc: visibility into growth + low-importance candidate list.
  // Suggest-mode only — does not auto-evict. Auto-eviction policy TBD;
  // see TODO in runMnemonGc().
  { name: 'mnemon-gc', cron: '0 4 * * *', handler: runMnemonGc },
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

async function runMnemonGc(): Promise<void> {
  await audit('CRON | mnemon-gc START');
  try {
    // Suggest-mode: surface low-importance candidates so we have visibility
    // into store growth without auto-deleting. If/when we want enforcement,
    // we can iterate this list and call `kb.forget(id)` for items past a
    // retention threshold (by age, access_count, or both). For now: log
    // the candidate count to audit so we can size the problem before
    // designing a policy.
    const kb = await getKnowledgeBase();
    const candidates = await kb.lowImportance(0.5, 50);
    await audit(
      `CRON | mnemon-gc END | candidates=${candidates.length}`,
    );
  } catch (e) {
    await audit(`CRON | mnemon-gc FAIL | ${(e as Error).message}`);
  }
}

async function runMorningDigest(): Promise<void> {
  await audit('CRON | morning-digest START');
  // Morning digest is delivery-driven: it composes a message and pushes it
  // through NanoClaw's outbound channel for the clawd group. Concrete
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

const inflight = new Map<string, Promise<void>>();

async function tick(): Promise<void> {
  const now = Date.now();
  for (const job of SCHEDULES) {
    const next = nextRunFromCron(job.cron, new Date(now));
    if (!next) continue;
    // Guard against concurrent execution: a long-running cloud-ingest can
    // outlast its tick and we must NOT spawn a duplicate.
    if (inflight.has(job.name)) continue;
    const last = lastRun.get(job.name) ?? 0;
    // Run if the scheduled time is within the last minute and we haven't
    // already run within the last 5 minutes.
    const sched = new Date(now);
    sched.setHours(next.getHours(), next.getMinutes(), 0, 0);
    if (sched.getTime() > now) {
      sched.setDate(sched.getDate() - 1); // most recent past occurrence
    }
    if (sched.getTime() > now - 60 * 1000 && now - last > 5 * 60 * 1000) {
      // Record dispatch time so a retry within 5 minutes is skipped.
      // lastRun is updated again on completion (not strictly necessary but
      // keeps the timestamp accurate for catch-up logic).
      lastRun.set(job.name, now);
      const p = job.handler().finally(() => {
        inflight.delete(job.name);
        lastRun.set(job.name, Date.now());
      });
      inflight.set(job.name, p);
      void p;
    }
  }
}

export function startClawdCron(): void {
  if (driverTimer) return;
  // Validate every cron pattern before starting — nextRunFromCron only
  // supports `M H * * *`, so any other pattern would silently never fire.
  // Audit-log unsupported patterns so operators see them instead of waiting
  // forever for a job that can't run.
  for (const job of SCHEDULES) {
    if (nextRunFromCron(job.cron) === null) {
      void audit(
        `CLAWD_CRON_UNPARSEABLE | job=${job.name} cron=${job.cron} ` +
          `(supported pattern: 'M H * * *'). Job will NOT fire.`,
      );
    }
  }
  void audit('CLAWD_START | cron driver running, jobs=cloud-ingest@02:00, wiki-regen@03:00, mnemon-gc@04:00, morning-digest@07:00');
  driverTimer = setInterval(() => void tick(), driverInterval);
  // Don't keep the event loop alive on shutdown — stopClawdCron clears
  // explicitly, but unref guards against forgetting to call it on SIGTERM.
  if (typeof driverTimer.unref === 'function') driverTimer.unref();
  // Kick off file-watcher in background; failure here must not prevent
  // the cron driver from running.
  void startFileWatcher().catch((err) => {
    void audit(`FILE_WATCHER_FAIL | ${(err as Error).message}`);
  });
  // Telegram MTProto ingester — no-ops if creds/session not present yet.
  void startTelegramMtprotoIngester().catch((err) => {
    void audit(`MTPROTO_FAIL | ${(err as Error).message}`);
  });
}

/** Pipe a single Fact into the knowledge base. */
async function mnemonRemember(
  text: string,
  tags: string[],
  source: string,
  sourceId: string,
): Promise<void> {
  // Errors are swallowed by design — file-watcher must not die on a single
  // failed write. The KB layer handles transient pgvector retries internally.
  try {
    const kb = await getKnowledgeBase();
    await kb.store({ text, source, source_id: sourceId, tags });
  } catch {
    /* swallow */
  }
}

let fileWatcherStarted = false;
async function startFileWatcher(): Promise<void> {
  if (fileWatcherStarted) return;
  fileWatcherStarted = true;
  const registry = new ProcessedRegistry();
  await audit('FILE_WATCHER_START | configuring chokidar over WATCH_PATHS_ROOT');
  let processed = 0;
  let skipped = 0;
  await watchAllConfiguredRoots(async (file: string) => {
    try {
      const result = await processFile(file, registry);
      if (result === null) {
        skipped += 1;
        return;
      }
      // Each chunk → KB insight, tagged for source-attribution. The Fact
      // already carries a stable (source, sourceId) pair derived from the
      // file's SHA + chunk index, so re-ingestion of unchanged files is a
      // dedup no-op at the (source, source_id) unique constraint.
      for (const fact of result.facts) {
        await mnemonRemember(
          fact.text,
          ['clawd', `src:file`, `path:${truncForTag(fact.source)}`],
          fact.source,
          fact.sourceId ?? fact.source,
        );
      }
      processed += 1;
      if (processed % 100 === 0) {
        void audit(`FILE_WATCHER_PROGRESS | processed=${processed} skipped=${skipped}`);
      }
    } catch (err) {
      // Per-file failure must not kill the watcher
      void audit(`FILE_WATCHER_FILE_FAIL | ${file} | ${(err as Error).message}`);
    }
  });
  void audit('FILE_WATCHER_RUNNING | listening for adds + changes');
}

function truncForTag(value: string): string {
  return value.replace(/[\s,]/g, '_').slice(0, 80);
}

export function stopClawdCron(): void {
  if (driverTimer) {
    clearInterval(driverTimer);
    driverTimer = null;
  }
}

// Self-register on import — same pattern as other modules in this folder.
startClawdCron();
