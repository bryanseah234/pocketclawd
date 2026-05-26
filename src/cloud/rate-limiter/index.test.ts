/**
 * Unit tests for Rate Limiter (task 4.2).
 * Mocks ioredis to verify correct Redis Sorted Set command construction,
 * sliding window logic, and retry-after calculation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ioredis with vi.hoisted for proper hoisting
const { mockRedisInstance, MockRedis } = vi.hoisted(() => {
    const instance = {
        zremrangebyscore: vi.fn().mockResolvedValue(0),
        zcard: vi.fn().mockResolvedValue(0),
        zrange: vi.fn().mockResolvedValue([]),
        zadd: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
    };

    function MockRedisConstructor() {
        return instance;
    }

    return {
        mockRedisInstance: instance,
        MockRedis: MockRedisConstructor,
    };
});

vi.mock('ioredis', () => ({
    default: MockRedis,
}));

// Import after mocks
const { RateLimiter } = await import('./index.js');

describe('RateLimiter', () => {
    let limiter: InstanceType<typeof RateLimiter>;

    beforeEach(() => {
        vi.clearAllMocks();
        // Create a mock Redis instance and pass it to the limiter
        const redis = new (MockRedis as unknown as new () => unknown)();
        limiter = new RateLimiter(redis as never);
    });

    describe('checkLimit', () => {
        it('allows message when both limits have capacity', async () => {
            mockRedisInstance.zcard.mockResolvedValueOnce(5);  // user count
            mockRedisInstance.zcard.mockResolvedValueOnce(50); // global count

            const result = await limiter.checkLimit('user-1');

            expect(result.allowed).toBe(true);
            expect(result.retryAfterMs).toBeNull();
            expect(result.remaining).toBe(14); // min(20-5-1, 200-50-1) = min(14, 149) = 14
        });

        it('denies message when user limit is reached (20/min)', async () => {
            mockRedisInstance.zcard.mockResolvedValueOnce(20); // user count at limit
            mockRedisInstance.zrange.mockResolvedValueOnce(['member1', String(Date.now() - 30_000)]);

            const result = await limiter.checkLimit('user-1');

            expect(result.allowed).toBe(false);
            expect(result.reason).toBe('user_limit');
            expect(result.remaining).toBe(0);
            expect(result.retryAfterMs).toBeGreaterThan(0);
        });

        it('denies message when global limit is reached (200/hr)', async () => {
            mockRedisInstance.zcard
                .mockResolvedValueOnce(10)   // user count (under limit)
                .mockResolvedValueOnce(200); // global count at limit
            mockRedisInstance.zrange.mockResolvedValueOnce(['member1', String(Date.now() - 1_800_000)]);

            const result = await limiter.checkLimit('user-1');

            expect(result.allowed).toBe(false);
            expect(result.reason).toBe('global_limit');
            expect(result.remaining).toBe(0);
            expect(result.retryAfterMs).toBeGreaterThan(0);
        });

        it('checks user limit before global limit', async () => {
            // Both limits exceeded — should report user_limit since it's checked first
            mockRedisInstance.zcard.mockResolvedValueOnce(20); // user count at limit
            mockRedisInstance.zrange.mockResolvedValueOnce(['member1', String(Date.now() - 30_000)]);

            const result = await limiter.checkLimit('user-1');

            expect(result.reason).toBe('user_limit');
            // Global check should not have been called
            expect(mockRedisInstance.zcard).toHaveBeenCalledTimes(1);
        });

        it('removes expired entries before counting (user window)', async () => {
            mockRedisInstance.zcard.mockResolvedValueOnce(0);
            mockRedisInstance.zcard.mockResolvedValueOnce(0);

            await limiter.checkLimit('user-1');

            // First zremrangebyscore call is for user key
            expect(mockRedisInstance.zremrangebyscore).toHaveBeenCalledWith(
                'ratelimit:user:user-1:minute',
                '-inf',
                expect.any(Number),
            );
        });

        it('removes expired entries before counting (global window)', async () => {
            mockRedisInstance.zcard.mockResolvedValueOnce(0);
            mockRedisInstance.zcard.mockResolvedValueOnce(0);

            await limiter.checkLimit('user-1');

            // Second zremrangebyscore call is for global key
            expect(mockRedisInstance.zremrangebyscore).toHaveBeenCalledWith(
                'ratelimit:global:hour',
                '-inf',
                expect.any(Number),
            );
        });

        it('calculates retry-after from oldest entry in user window', async () => {
            const now = Date.now();
            const oldestTimestamp = now - 50_000; // 50 seconds ago

            mockRedisInstance.zcard.mockResolvedValueOnce(20);
            mockRedisInstance.zrange.mockResolvedValueOnce(['oldest-member', String(oldestTimestamp)]);

            const result = await limiter.checkLimit('user-1');

            // Retry after = oldest timestamp + 60s window - now ≈ 10s
            expect(result.retryAfterMs).toBeGreaterThan(0);
            expect(result.retryAfterMs).toBeLessThanOrEqual(10_100); // ~10s with small tolerance
        });

        it('calculates retry-after from oldest entry in global window', async () => {
            const now = Date.now();
            const oldestTimestamp = now - 3_500_000; // 3500 seconds ago

            mockRedisInstance.zcard
                .mockResolvedValueOnce(5)    // user under limit
                .mockResolvedValueOnce(200); // global at limit
            mockRedisInstance.zrange.mockResolvedValueOnce(['oldest-member', String(oldestTimestamp)]);

            const result = await limiter.checkLimit('user-1');

            // Retry after = oldest timestamp + 3600s window - now ≈ 100s
            expect(result.retryAfterMs).toBeGreaterThan(0);
            expect(result.retryAfterMs).toBeLessThanOrEqual(100_100);
        });

        it('returns remaining as minimum of both limits', async () => {
            mockRedisInstance.zcard
                .mockResolvedValueOnce(18)   // user: 18 used, 1 remaining
                .mockResolvedValueOnce(50);  // global: 50 used, 149 remaining

            const result = await limiter.checkLimit('user-1');

            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(1); // min(20-18-1, 200-50-1) = min(1, 149) = 1
        });

        it('throws on empty userId', async () => {
            await expect(limiter.checkLimit('')).rejects.toThrow('userId is required');
        });

        it('throws on whitespace-only userId', async () => {
            await expect(limiter.checkLimit('   ')).rejects.toThrow('userId is required');
        });
    });

    describe('recordMessage', () => {
        it('adds entry to user sorted set with timestamp score', async () => {
            await limiter.recordMessage('user-1');

            expect(mockRedisInstance.zadd).toHaveBeenCalledWith(
                'ratelimit:user:user-1:minute',
                expect.any(Number),
                expect.stringContaining('user-1:'),
            );
        });

        it('adds entry to global sorted set with timestamp score', async () => {
            await limiter.recordMessage('user-1');

            expect(mockRedisInstance.zadd).toHaveBeenCalledWith(
                'ratelimit:global:hour',
                expect.any(Number),
                expect.stringContaining('user-1:'),
            );
        });

        it('sets TTL on user key (120s)', async () => {
            await limiter.recordMessage('user-1');

            expect(mockRedisInstance.expire).toHaveBeenCalledWith(
                'ratelimit:user:user-1:minute',
                120,
            );
        });

        it('sets TTL on global key (7200s)', async () => {
            await limiter.recordMessage('user-1');

            expect(mockRedisInstance.expire).toHaveBeenCalledWith(
                'ratelimit:global:hour',
                7200,
            );
        });

        it('uses unique member names to avoid deduplication', async () => {
            await limiter.recordMessage('user-1');
            await limiter.recordMessage('user-1');

            const firstMember = mockRedisInstance.zadd.mock.calls[0][2];
            const secondMember = mockRedisInstance.zadd.mock.calls[2][2]; // calls[2] because each recordMessage makes 2 zadd calls

            expect(firstMember).not.toBe(secondMember);
        });

        it('throws on empty userId', async () => {
            await expect(limiter.recordMessage('')).rejects.toThrow('userId is required');
        });
    });

    describe('key prefix', () => {
        let prefixedLimiter: InstanceType<typeof RateLimiter>;

        beforeEach(() => {
            const redis = new (MockRedis as unknown as new () => unknown)();
            prefixedLimiter = new RateLimiter(redis as never, { keyPrefix: 'prod' });
        });

        it('applies prefix to user key', async () => {
            mockRedisInstance.zcard.mockResolvedValueOnce(0);
            mockRedisInstance.zcard.mockResolvedValueOnce(0);

            await prefixedLimiter.checkLimit('user-1');

            expect(mockRedisInstance.zremrangebyscore).toHaveBeenCalledWith(
                'prod:ratelimit:user:user-1:minute',
                '-inf',
                expect.any(Number),
            );
        });

        it('applies prefix to global key', async () => {
            mockRedisInstance.zcard.mockResolvedValueOnce(0);
            mockRedisInstance.zcard.mockResolvedValueOnce(0);

            await prefixedLimiter.checkLimit('user-1');

            expect(mockRedisInstance.zremrangebyscore).toHaveBeenCalledWith(
                'prod:ratelimit:global:hour',
                '-inf',
                expect.any(Number),
            );
        });

        it('applies prefix to record keys', async () => {
            await prefixedLimiter.recordMessage('user-1');

            expect(mockRedisInstance.zadd).toHaveBeenCalledWith(
                'prod:ratelimit:user:user-1:minute',
                expect.any(Number),
                expect.any(String),
            );
            expect(mockRedisInstance.zadd).toHaveBeenCalledWith(
                'prod:ratelimit:global:hour',
                expect.any(Number),
                expect.any(String),
            );
        });
    });

    describe('custom config', () => {
        it('respects custom user limit', async () => {
            const redis = new (MockRedis as unknown as new () => unknown)();
            const customLimiter = new RateLimiter(redis as never, { userLimitPerMinute: 5 });

            mockRedisInstance.zcard.mockResolvedValueOnce(5); // at custom limit
            mockRedisInstance.zrange.mockResolvedValueOnce(['m', String(Date.now() - 30_000)]);

            const result = await customLimiter.checkLimit('user-1');

            expect(result.allowed).toBe(false);
            expect(result.reason).toBe('user_limit');
        });

        it('respects custom global limit', async () => {
            const redis = new (MockRedis as unknown as new () => unknown)();
            const customLimiter = new RateLimiter(redis as never, { globalLimitPerHour: 50 });

            mockRedisInstance.zcard
                .mockResolvedValueOnce(0)    // user under limit
                .mockResolvedValueOnce(50);  // global at custom limit
            mockRedisInstance.zrange.mockResolvedValueOnce(['m', String(Date.now() - 1_800_000)]);

            const result = await customLimiter.checkLimit('user-1');

            expect(result.allowed).toBe(false);
            expect(result.reason).toBe('global_limit');
        });
    });
});
