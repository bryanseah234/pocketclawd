"""
Redis-based sliding window rate limiter for the NanoClaw sub-agent.
Per-user: 20 messages/min. Global: 200 messages/hr.
"""
import logging
import time

from redis.asyncio import Redis

logger = logging.getLogger(__name__)


class RateLimiter:
    def __init__(
        self,
        redis: Redis,
        user_limit_per_min: int = 20,
        global_limit_per_hour: int = 200,
    ) -> None:
        self.redis = redis
        self.user_limit_per_min = user_limit_per_min
        self.global_limit_per_hour = global_limit_per_hour

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
