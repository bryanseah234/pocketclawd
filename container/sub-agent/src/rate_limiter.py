"""
Redis-based sliding window rate limiter for the NanoClaw sub-agent.
Per-user: 20 messages/min. Global: 200 messages/hr.

NOTE: This is a SECONDARY (advisory) rate limiter inside the sub-agent.
PRIMARY rate limiting is enforced by the TypeScript orchestrator
(src/cloud/rate-limiter/index.ts) BEFORE messages are enqueued to Redis.
Duplicate implementation kept intentionally as a defense-in-depth layer,
but these two limiters use DIFFERENT Redis key namespaces and are not
coordinated. Do not rely on this as the sole rate limit enforcement.
"""
import logging
import time

from redis.asyncio import Redis

logger = logging.getLogger(__name__)


class RateLimiter:
    def __init__(
        self,
        redis: Redis,
        user_limit_per_min: int | None = None,
        global_limit_per_hour: int | None = None,
    ) -> None:
        import os as _os
        self.redis = redis
        # Env-configurable so load/integration tests can raise the caps without
        # a code change. Defaults preserve production behaviour (20/min, 200/hr).
        self.user_limit_per_min = (
            user_limit_per_min if user_limit_per_min is not None
            else int(_os.environ.get("RATE_LIMIT_USER_PER_MIN", "20"))
        )
        self.global_limit_per_hour = (
            global_limit_per_hour if global_limit_per_hour is not None
            else int(_os.environ.get("RATE_LIMIT_GLOBAL_PER_HOUR", "200"))
        )

    async def check_and_record(self, user_id: str) -> tuple[bool, str]:
        """
        Returns (allowed, reason).
        Uses Redis sorted sets with sliding window.
        """
        now_ms = int(time.time() * 1000)
        user_key = f"ratelimit:user:{user_id}"
        global_key = "ratelimit:global"

        pipe = self.redis.pipeline(transaction=True)
        # Remove expired per-user entries (older than 60s)
        pipe.zremrangebyscore(user_key, 0, now_ms - 60_000)
        pipe.zcard(user_key)
        # Remove expired global entries (older than 1hr)
        pipe.zremrangebyscore(global_key, 0, now_ms - 3_600_000)
        pipe.zcard(global_key)
        results = await pipe.execute()

        user_count: int = results[1]
        global_count: int = results[3]

        if user_count >= self.user_limit_per_min:
            return False, f"Rate limit exceeded: {self.user_limit_per_min} messages per minute"
        if global_count >= self.global_limit_per_hour:
            return False, f"Global rate limit exceeded: {self.global_limit_per_hour} messages per hour"

        # Record this message
        entry_id = f"{now_ms}-{user_id}-{id(object())}"
        pipe2 = self.redis.pipeline(transaction=True)
        pipe2.zadd(user_key, {entry_id: now_ms})
        pipe2.expire(user_key, 3600)
        pipe2.zadd(global_key, {entry_id: now_ms})
        pipe2.expire(global_key, 7200)
        await pipe2.execute()

        return True, ""

    async def get_user_stats(self, user_id: str) -> dict:
        """Return messages_last_minute and messages_last_hour counts."""
        now_ms = int(time.time() * 1000)
        user_key = f"ratelimit:user:{user_id}"
        pipe = self.redis.pipeline()
        pipe.zcount(user_key, now_ms - 60_000, "+inf")
        pipe.zcount(user_key, now_ms - 3_600_000, "+inf")
        results = await pipe.execute()
        return {
            "messages_last_minute": results[0],
            "messages_last_hour": results[1],
        }

