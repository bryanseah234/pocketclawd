/**
 * Rate Limiter types — sliding window rate limiting using Redis Sorted Sets.
 *
 * Requirements: REQ-4.1
 */

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number | null;
    reason?: 'user_limit' | 'global_limit';
}

export interface RateLimiterConfig {
    userLimitPerMinute: number;  // default 20
    globalLimitPerHour: number;  // default 200
    keyPrefix?: string;
}
