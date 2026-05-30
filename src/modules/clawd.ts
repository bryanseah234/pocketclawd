/**
 * Clawd — runtime wiring (cloud cron driver).
 *
 * Imported for side effects from `src/modules/index.ts`. On host startup it
 * registers a single scheduled job — the 07:00 morning digest — behind a
 * cron driver with a Redis distributed lock so a restart mid-window (or a
 * second orchestrator replica) cannot double-run it.
 *
 * Cloud-only. The former local-mode jobs (file/cloud ingestion, wiki regen
 * from the local pgvector store, mnemon GC) were removed when local mode was
 * deleted; their persistence is now owned by DataGateway (DynamoDB + OpenSearch
 * + S3) and the digest reads DynamoDB directly via clawd-wiring.ts.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { envPath } from './paths.js';
import { getCloudServices } from '../cloud/bootstrap.js';
import { cronLockKey } from '../cloud/redis-lock.js';

const LOG_PATH = envPath('LOG_PATH', 'logs');
const AUDIT_LOG = path.join(LOG_PATH, 'audit.log');

const SCHEDULES = [
  { name: 'morning-digest', cron: '0 7 * * *', handler: runMorningDigest },
] as const;

const driverInterval = 60 * 1000; // poll every minute
let driverTimer: NodeJS.Timeout | null = null;
/**
 * In-process dedup map (degraded fallback). In cloud mode, tick() instead
 * acquires a Redis distributed lock (cronLockKey + SET NX EX) per scheduled
 * window so a restart mid-window — or a second replica — cannot double-run a
 * job. The Map is retained for degraded operation where no cloud Redis is
 * wired.
 */
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

async function runMorningDigest(): Promise<void> {
  await audit('CRON | morning-digest START');
  // Morning digest is delivery-driven: it composes a message and pushes it
  // through NanoClaw's outbound channel for the clawd group. Concrete wiring
  // is added by clawd-wiring.ts (Bedrock + DynamoDB); this keeps the cron
  // contract live and audited.
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

let digestCallback: (() => Promise<void>) | null = null;

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
    // Guard against concurrent execution: a long-running handler can outlast
    // its tick and we must NOT spawn a duplicate.
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
      // Distributed-lock guard (t2-10): when cloud services are wired, claim
      // the (job, scheduled-window) slot in Redis so a restart within the same
      // cron window — or a second orchestrator replica — cannot double-run the
      // job. The in-process lastRun Map remains as the degraded fallback.
      const cloud = getCloudServices();
      if (cloud?.redis) {
        const windowIso = sched.toISOString().slice(0, 16);
        const key = cronLockKey(job.name, windowIso);
        // Fire the async claim; only dispatch if we win it. We must not block
        // the synchronous tick loop, so handle the claim inside the promise.
        void (async () => {
          try {
            const claimed = await cloud.redis.set(key, '1', 'EX', 23 * 3600, 'NX');
            if (claimed !== 'OK') {
              return; // another process already ran this window
            }
          } catch {
            // Redis unavailable — fall through to local dedup (lastRun) below.
          }
          if (inflight.has(job.name)) return;
          lastRun.set(job.name, Date.now());
          const p = job.handler().finally(() => {
            inflight.delete(job.name);
            lastRun.set(job.name, Date.now());
          });
          inflight.set(job.name, p);
          void p;
        })();
        continue;
      }

      // Degraded fallback: in-process dedup only.
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
  for (const job of SCHEDULES) {
    if (nextRunFromCron(job.cron) === null) {
      void audit(
        `CLAWD_CRON_UNPARSEABLE | job=${job.name} cron=${job.cron} ` +
          `(supported pattern: 'M H * * *'). Job will NOT fire.`,
      );
    }
  }
  void audit('CLAWD_START | cron driver running, jobs=morning-digest@07:00');
  driverTimer = setInterval(() => void tick(), driverInterval);
  // Don't keep the event loop alive on shutdown — stopClawdCron clears
  // explicitly, but unref guards against forgetting to call it on SIGTERM.
  if (typeof driverTimer.unref === 'function') driverTimer.unref();
}

export function stopClawdCron(): void {
  if (driverTimer) {
    clearInterval(driverTimer);
    driverTimer = null;
  }
}

// Self-register on import — same pattern as other modules in this folder.
startClawdCron();
