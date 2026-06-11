/**
 * Redis-based sliding window rate limiter.
 * Per-user: 20 messages/min. Global: 200 messages/hr.
 */
import type { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export class RateLimiter {
  constructor(
    private redis: Redis,
    private userLimitPerMin = 20,
    private globalLimitPerHour = 200,
  ) {}

  async checkAndRecord(userId: string): Promise<RateLimitResult> {
    const now = Date.now();
    const userKey = `ratelimit:user:${userId}`;
    const globalKey = 'ratelimit:global';

    // Pipeline: remove expired, count, add new entry
    const pipeline = this.redis.multi();
    pipeline.zremrangebyscore(userKey, 0, now - 60_000);
    pipeline.zcard(userKey);
    pipeline.zremrangebyscore(globalKey, 0, now - 3_600_000);
    pipeline.zcard(globalKey);
    const results = await pipeline.exec();

    const userCount = (results?.[1]?.[1] as number) ?? 0;
    const globalCount = (results?.[3]?.[1] as number) ?? 0;

    if (userCount >= this.userLimitPerMin) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${this.userLimitPerMin} messages per minute`,
        retryAfterMs: 60_000,
      };
    }
    if (globalCount >= this.globalLimitPerHour) {
      return {
        allowed: false,
        reason: `Global rate limit exceeded: ${this.globalLimitPerHour} messages per hour`,
        retryAfterMs: 3_600_000,
      };
    }

    // Record this message
    const recordPipeline = this.redis.multi();
    recordPipeline.zadd(userKey, now, `${now}-${Math.random()}`);
    recordPipeline.expire(userKey, 3600);
    recordPipeline.zadd(globalKey, now, `${now}-${userId}-${Math.random()}`);
    recordPipeline.expire(globalKey, 7200);
    await recordPipeline.exec();

    return { allowed: true };
  }

  async getUserStats(userId: string): Promise<{ messagesLastMinute: number; messagesLastHour: number }> {
    const now = Date.now();
    const userKey = `ratelimit:user:${userId}`;
    const [min, hour] = await Promise.all([
      this.redis.zcount(userKey, now - 60_000, '+inf'),
      this.redis.zcount(userKey, now - 3_600_000, '+inf'),
    ]);
    return { messagesLastMinute: min, messagesLastHour: hour };
  }

  async resetUser(userId: string): Promise<void> {
    await this.redis.del(`ratelimit:user:${userId}`);
  }
}

export function createRateLimiter(
  redis: Redis,
  userLimitPerMin?: number,
  globalLimitPerHour?: number,
): RateLimiter {
  return new RateLimiter(redis, userLimitPerMin, globalLimitPerHour);
}
