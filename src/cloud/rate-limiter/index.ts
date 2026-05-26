/**
 * Sliding Window Rate Limiter — per-user and global rate limiting
 * using Redis Sorted Sets with timestamp scores.
 *
 * Key patterns:
 *   ratelimit:user:{userId}:minute  — Per-user messages in current minute window
 *   ratelimit:global:hour           — Global hourly message count
 *
 * Requirements: REQ-4.1
 */

import Redis from 'ioredis';

import type { RateLimitResult, RateLimiterConfig } from './types.js';

export type { RateLimitResult, RateLimiterConfig } from './types.js';

/** Default configuration values. */
const DEFAULT_CONFIG: RateLimiterConfig = {
    userLimitPerMinute: 20,
    globalLimitPerHour: 200,
};

/** One minute in milliseconds. */
const ONE_MINUTE_MS = 60_000;

/** One hour in milliseconds. */
const ONE_HOUR_MS = 3_600_000;

export class RateLimiter {
    private readonly redis: Redis;
    private readonly config: RateLimiterConfig;

    constructor(redis: Redis, config?: Partial<RateLimiterConfig>) {
        this.redis = redis;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Check whether a message from the given user is allowed under both
     * per-user (20/min) and global (200/hr) rate limits.
     *
     * Does NOT record the message — call `recordMessage` separately after
     * confirming the message will be processed.
     */
    async checkLimit(userId: string): Promise<RateLimitResult> {
        this.assertUserId(userId);

        const now = Date.now();

        // Check per-user limit first (20 messages per minute)
        const userKey = this.userKey(userId);
        const userWindowStart = now - ONE_MINUTE_MS;

        // Remove expired entries and count current window
        await this.redis.zremrangebyscore(userKey, '-inf', userWindowStart);
        const userCount = await this.redis.zcard(userKey);

        if (userCount >= this.config.userLimitPerMinute) {
            // Denied by user limit — calculate retry-after from oldest entry
            const oldest = await this.redis.zrange(userKey, 0, 0, 'WITHSCORES');
            const retryAfterMs = oldest.length >= 2
                ? Math.max(0, Number(oldest[1]) + ONE_MINUTE_MS - now)
                : ONE_MINUTE_MS;

            return {
                allowed: false,
                remaining: 0,
                retryAfterMs,
                reason: 'user_limit',
            };
        }

        // Check global limit (200 messages per hour)
        const globalKey = this.globalKey();
        const globalWindowStart = now - ONE_HOUR_MS;

        await this.redis.zremrangebyscore(globalKey, '-inf', globalWindowStart);
        const globalCount = await this.redis.zcard(globalKey);

        if (globalCount >= this.config.globalLimitPerHour) {
            // Denied by global limit — calculate retry-after from oldest entry
            const oldest = await this.redis.zrange(globalKey, 0, 0, 'WITHSCORES');
            const retryAfterMs = oldest.length >= 2
                ? Math.max(0, Number(oldest[1]) + ONE_HOUR_MS - now)
                : ONE_HOUR_MS;

            return {
                allowed: false,
                remaining: 0,
                retryAfterMs,
                reason: 'global_limit',
            };
        }

        // Allowed — return remaining capacity (minimum of both limits)
        const userRemaining = this.config.userLimitPerMinute - userCount - 1;
        const globalRemaining = this.config.globalLimitPerHour - globalCount - 1;

        return {
            allowed: true,
            remaining: Math.min(userRemaining, globalRemaining),
            retryAfterMs: null,
        };
    }

    /**
     * Record a message from the given user in both the per-user and global
     * sorted sets. Call this after confirming the message will be processed.
     */
    async recordMessage(userId: string): Promise<void> {
        this.assertUserId(userId);

        const now = Date.now();
        const member = `${userId}:${now}:${Math.random().toString(36).slice(2, 8)}`;

        const userKey = this.userKey(userId);
        const globalKey = this.globalKey();

        // Add to both sorted sets with current timestamp as score
        await this.redis.zadd(userKey, now, member);
        await this.redis.zadd(globalKey, now, member);

        // Set TTL on keys to auto-expire (slightly longer than window to avoid edge cases)
        await this.redis.expire(userKey, 120);   // 2 minutes for per-user key
        await this.redis.expire(globalKey, 7200); // 2 hours for global key
    }

    // ── Private helpers ──

    private userKey(userId: string): string {
        const base = `ratelimit:user:${userId}:minute`;
        return this.config.keyPrefix ? `${this.config.keyPrefix}:${base}` : base;
    }

    private globalKey(): string {
        const base = 'ratelimit:global:hour';
        return this.config.keyPrefix ? `${this.config.keyPrefix}:${base}` : base;
    }

    private assertUserId(userId: string): void {
        if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
            throw new Error('RateLimiter: userId is required');
        }
    }
}
