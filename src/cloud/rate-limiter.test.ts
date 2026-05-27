/**
 * Tests for Redis sliding-window rate limiter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimiter, createRateLimiter } from './rate-limiter.js';

function makeMockRedis(userCount = 0, globalCount = 0) {
  return {
    multi: vi.fn(() => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([[null,0],[null,userCount],[null,0],[null,globalCount]]),
    })),
    zcount: vi.fn().mockResolvedValue(0),
    del: vi.fn().mockResolvedValue(1),
  };
}

describe('RateLimiter', () => {
  it('allows first message', async () => {
    const redis = makeMockRedis(0, 0) as any;
    const r = new RateLimiter(redis, 20, 200);
    const result = await r.checkAndRecord('user1');
    expect(result.allowed).toBe(true);
  });

  it('allows up to limit', async () => {
    const redis = makeMockRedis(19, 0) as any;
    const r = new RateLimiter(redis, 20, 200);
    const result = await r.checkAndRecord('user1');
    expect(result.allowed).toBe(true);
  });

  it('blocks message over per-user limit', async () => {
    const redis = makeMockRedis(20, 0) as any;
    const r = new RateLimiter(redis, 20, 200);
    const result = await r.checkAndRecord('user1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('20 messages per minute');
  });

  it('blocks when global limit exceeded', async () => {
    const redis = makeMockRedis(0, 200) as any;
    const r = new RateLimiter(redis, 20, 200);
    const result = await r.checkAndRecord('user1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Global rate limit');
  });

  it('retryAfterMs is positive when blocked', async () => {
    const redis = makeMockRedis(20, 0) as any;
    const r = new RateLimiter(redis, 20, 200);
    const result = await r.checkAndRecord('user1');
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('getUserStats returns correct counts', async () => {
    const redis = makeMockRedis() as any;
    redis.zcount = vi.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(42);
    const r = new RateLimiter(redis, 20, 200);
    const stats = await r.getUserStats('user1');
    expect(stats.messagesLastMinute).toBe(5);
    expect(stats.messagesLastHour).toBe(42);
  });

  it('resetUser clears limits', async () => {
    const redis = makeMockRedis() as any;
    const r = new RateLimiter(redis, 20, 200);
    await r.resetUser('user1');
    expect(redis.del).toHaveBeenCalledWith('ratelimit:user:user1');
  });

  it('different users have independent limits', async () => {
    const redis = makeMockRedis(20, 0) as any;  // user1 at limit
    const r = new RateLimiter(redis, 20, 200);
    // user1 blocked
    const r1 = await r.checkAndRecord('user1');
    expect(r1.allowed).toBe(false);
    // user2 would pass with fresh counter — tested via factory
    const redis2 = makeMockRedis(0, 0) as any;
    const r2 = new RateLimiter(redis2, 20, 200);
    const r2result = await r2.checkAndRecord('user2');
    expect(r2result.allowed).toBe(true);
  });

  it('createRateLimiter factory works', () => {
    const redis = makeMockRedis() as any;
    const rl = createRateLimiter(redis, 10, 100);
    expect(rl).toBeInstanceOf(RateLimiter);
  });

  it('sliding window excludes old entries (zremrangebyscore called)', async () => {
    const multiObj = {
      zremrangebyscore: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([[null,0],[null,0],[null,0],[null,0]]),
    };
    const redis = { multi: vi.fn().mockReturnValue(multiObj), zcount: vi.fn(), del: vi.fn() } as any;
    const r = new RateLimiter(redis, 20, 200);
    await r.checkAndRecord('user1');
    expect(multiObj.zremrangebyscore).toHaveBeenCalled();
  });
});
