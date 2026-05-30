/**
 * Redis distributed lock + idempotency helpers.
 *
 * Used to make cron jobs and scheduled notifications idempotent across
 * orchestrator restarts and (future) multiple orchestrator replicas.
 *
 * - acquireLock: SET NX EX — only one holder per key per TTL window.
 *   Returns a token; release only succeeds if the token still matches
 *   (guards against releasing a lock that already expired and was re-taken).
 * - markOnce / wasMarked: SET NX EX flag for "did X already happen in
 *   window W" dedup (e.g. "user U notified on date D").
 *
 * All operations no-op-safe: if Redis is briefly unavailable, callers should
 * treat a thrown error as "could not acquire" and skip rather than double-run.
 *
 * Resolves t2-10 (cron lastRun + distributed lock) and t2-11 (scheduler
 * notifiedToday persistence).
 */

import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

// Lua: release only if the stored token matches ours (atomic check-and-del).
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

export interface DistributedLock {
    /**
     * Try to acquire a lock. Returns a release token on success, or null if
     * the lock is already held.
     */
    acquire(key: string, ttlSeconds: number): Promise<string | null>;
    /** Release a previously acquired lock (only if the token still matches). */
    release(key: string, token: string): Promise<boolean>;
    /**
     * Atomically mark a one-time event in a TTL window. Returns true if THIS
     * call set the flag (i.e. it had not been marked yet), false if it was
     * already marked.
     */
    markOnce(key: string, ttlSeconds: number): Promise<boolean>;
    /** Check whether a one-time event flag is set. */
    wasMarked(key: string): Promise<boolean>;
}

export class RedisDistributedLock implements DistributedLock {
    constructor(private readonly redis: Redis) {}

    async acquire(key: string, ttlSeconds: number): Promise<string | null> {
        const token = randomUUID();
        // SET key token NX EX ttl
        const res = await this.redis.set(key, token, 'EX', ttlSeconds, 'NX');
        return res === 'OK' ? token : null;
    }

    async release(key: string, token: string): Promise<boolean> {
        const res = (await this.redis.eval(RELEASE_SCRIPT, 1, key, token)) as number;
        return res === 1;
    }

    async markOnce(key: string, ttlSeconds: number): Promise<boolean> {
        const res = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
        return res === 'OK';
    }

    async wasMarked(key: string): Promise<boolean> {
        return (await this.redis.exists(key)) === 1;
    }
}

// ── Key builders (kept here so TS + Python stay in sync via REDIS_KEYS doc) ──

/** Lock key for a cron job's execution window. */
export function cronLockKey(jobName: string, windowIso: string): string {
    return `nanoclaw:cron-lock:${jobName}:${windowIso}`;
}

/** Dedup flag key for "user U was notified on date D". */
export function notifiedKey(userId: string, dateYYYYMMDD: string): string {
    return `nanoclaw:notified:${userId}:${dateYYYYMMDD}`;
}
