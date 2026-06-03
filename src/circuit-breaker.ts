import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const CB_PATH = path.join(DATA_DIR, 'circuit-breaker.json');
const CLEAN_MARKER_PATH = path.join(DATA_DIR, 'clean-shutdown.marker');
const RESET_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Index = number of consecutive crashes (0 = clean start, attempt 1).
// 6+ crashes capped at 15min.
// Index = number of consecutive crashes (0-indexed in the array, but the
// `attempt` arg is 1-indexed: attempt=1 is a clean start = idx 0 = no delay).
// attempt=2 means we already crashed once within the reset window — give it
// a 5s pause so a true crash loop can't burn 5 restarts/sec. Capped at 15min
// from attempt 7 onward.
// Per req: shortened schedule (max 5min) and SIGTERM/SIGINT exempted via
// `clean-shutdown.marker` written by index.ts on graceful exit.
const BACKOFF_SCHEDULE_S = [0, 5, 10, 30, 60, 120, 300];

interface CircuitBreakerState {
  attempt: number;
  timestamp: string;
}

function read(): CircuitBreakerState | null {
  try {
    const raw = fs.readFileSync(CB_PATH, 'utf-8');
    return JSON.parse(raw) as CircuitBreakerState;
  } catch {
    return null;
  }
}

function write(state: CircuitBreakerState): void {
  // The breaker runs before initDb (which is what creates DATA_DIR), so on a
  // fresh checkout the dir may not exist yet.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CB_PATH, JSON.stringify(state, null, 2) + '\n');
}

function getDelay(attempt: number): number {
  const idx = Math.min(attempt - 1, BACKOFF_SCHEDULE_S.length - 1);
  return BACKOFF_SCHEDULE_S[idx];
}

export function resetCircuitBreaker(): void {
  try {
    fs.unlinkSync(CB_PATH);
  } catch {
    // Expected when no breaker file exists (first run / already reset).
  }
  // Also write a clean-shutdown marker so the NEXT process startup
  // can definitively distinguish graceful exit (deploy / SIGTERM) from
  // a crash. Without this marker the new process would still load any
  // stale circuit-breaker.json written before the unlink raced.
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CLEAN_MARKER_PATH, new Date().toISOString());
    log.info('Circuit breaker reset + clean shutdown marker written');
  } catch (err) {
    log.warn('Failed to write clean-shutdown marker', { err: err instanceof Error ? err.message : String(err) });
  }
}

export async function enforceStartupBackoff(): Promise<void> {
  const now = new Date();

  // Graceful shutdown via SIGTERM/SIGINT writes CLEAN_MARKER. If present,
  // the previous run exited cleanly (deploy/restart, not a crash).
  // Reset the breaker and skip any backoff.
  let cleanShutdown = false;
  try {
    fs.statSync(CLEAN_MARKER_PATH);
    cleanShutdown = true;
    fs.unlinkSync(CLEAN_MARKER_PATH);
    log.info('Clean shutdown marker found - circuit breaker reset', { path: CLEAN_MARKER_PATH });
  } catch {
    // No clean-shutdown marker => previous exit was not graceful (crash/kill);
    // fall through to normal backoff evaluation below.
  }

  const prev = read();

  let attempt: number;
  if (!prev || cleanShutdown) {
    attempt = 1;
  } else {
    const elapsedMs = now.getTime() - new Date(prev.timestamp).getTime();
    if (elapsedMs < RESET_WINDOW_MS) {
      attempt = prev.attempt + 1;
      log.warn('Previous startup was not a clean shutdown', {
        previousAttempt: prev.attempt,
        previousTimestamp: prev.timestamp,
        elapsedSec: Math.round(elapsedMs / 1000),
      });
    } else {
      attempt = 1;
      log.info('Circuit breaker reset — last startup was over 1h ago', {
        previousAttempt: prev.attempt,
        previousTimestamp: prev.timestamp,
      });
    }
  }

  write({ attempt, timestamp: now.toISOString() });

  const delaySec = getDelay(attempt);
  if (delaySec > 0) {
    const resumeAt = new Date(now.getTime() + delaySec * 1000).toISOString();
    log.warn('Circuit breaker: delaying startup due to repeated crashes', {
      attempt,
      delaySec,
      resumeAt,
    });
    await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
    log.info('Circuit breaker: backoff complete, resuming startup', { attempt });
  }
}
