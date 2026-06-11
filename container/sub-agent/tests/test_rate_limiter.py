"""Tests for Redis sliding window rate limiter."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import time


def make_redis(user_count=0, global_count=0):
    pipe = AsyncMock()
    pipe.zremrangebyscore = MagicMock(return_value=pipe)
    pipe.zcard = MagicMock(return_value=pipe)
    pipe.zadd = MagicMock(return_value=pipe)
    pipe.expire = MagicMock(return_value=pipe)
    pipe.zcount = AsyncMock()
    pipe.execute = AsyncMock(return_value=[0, user_count, 0, global_count])
    redis = AsyncMock()
    redis.pipeline = MagicMock(return_value=pipe)
    pipe2 = AsyncMock()
    pipe2.zadd = MagicMock(return_value=pipe2)
    pipe2.expire = MagicMock(return_value=pipe2)
    pipe2.execute = AsyncMock(return_value=[1, 1, 1, 1])
    redis.pipeline.side_effect = [pipe, pipe2, pipe, pipe2, pipe, pipe2, pipe, pipe2, pipe, pipe2, pipe, pipe2]
    redis.zcount = AsyncMock(return_value=0)
    redis.del_ = AsyncMock(return_value=1)
    redis.delete = AsyncMock(return_value=1)
    return redis, pipe


@pytest.mark.asyncio
async def test_allows_first_message():
    from src.rate_limiter import RateLimiter
    redis, _ = make_redis(0, 0)
    r = RateLimiter(redis, 20, 200)
    allowed, reason = await r.check_and_record("u1")
    assert allowed is True


@pytest.mark.asyncio
async def test_allows_up_to_limit():
    from src.rate_limiter import RateLimiter
    redis, _ = make_redis(19, 0)
    r = RateLimiter(redis, 20, 200)
    allowed, _ = await r.check_and_record("u1")
    assert allowed is True


@pytest.mark.asyncio
async def test_blocks_message_over_per_user_limit():
    from src.rate_limiter import RateLimiter
    redis, _ = make_redis(20, 0)
    r = RateLimiter(redis, 20, 200)
    allowed, reason = await r.check_and_record("u1")
    assert allowed is False
    assert "20" in reason


@pytest.mark.asyncio
async def test_global_limit_blocks_when_exceeded():
    from src.rate_limiter import RateLimiter
    redis, _ = make_redis(0, 200)
    r = RateLimiter(redis, 20, 200)
    allowed, reason = await r.check_and_record("u1")
    assert allowed is False
    assert "Global" in reason or "global" in reason


@pytest.mark.asyncio
async def test_different_users_have_independent_limits():
    from src.rate_limiter import RateLimiter
    redis1, _ = make_redis(20, 0)
    redis2, _ = make_redis(0, 0)
    r1 = RateLimiter(redis1, 20, 200)
    r2 = RateLimiter(redis2, 20, 200)
    allowed1, _ = await r1.check_and_record("u1")
    allowed2, _ = await r2.check_and_record("u2")
    assert allowed1 is False
    assert allowed2 is True


@pytest.mark.asyncio
async def test_get_user_stats_returns_correct_counts():
    from src.rate_limiter import RateLimiter
    redis, _ = make_redis()
    pipe = AsyncMock()
    pipe.zcount = MagicMock(return_value=pipe)
    pipe.execute = AsyncMock(return_value=[7, 42])
    redis.pipeline = MagicMock(return_value=pipe)
    r = RateLimiter(redis, 20, 200)
    stats = await r.get_user_stats("u1")
    assert stats["messages_last_minute"] == 7
    assert stats["messages_last_hour"] == 42


@pytest.mark.asyncio
async def test_sliding_window_removes_old_entries():
    from src.rate_limiter import RateLimiter
    redis, pipe = make_redis(0, 0)
    r = RateLimiter(redis, 20, 200)
    await r.check_and_record("u1")
    pipe.zremrangebyscore.assert_called()


@pytest.mark.asyncio
async def test_check_and_record_allowed_message_is_recorded():
    from src.rate_limiter import RateLimiter
    redis, _ = make_redis(0, 0)
    pipe2 = AsyncMock()
    pipe2.zadd = MagicMock(return_value=pipe2)
    pipe2.expire = MagicMock(return_value=pipe2)
    pipe2.execute = AsyncMock(return_value=[1, 1, 1, 1])
    call_count = [0]
    original = redis.pipeline.side_effect
    def side_effect(*a, **kw):
        call_count[0] += 1
        if call_count[0] % 2 == 0:
            return pipe2
        pipe = AsyncMock()
        pipe.zremrangebyscore = MagicMock(return_value=pipe)
        pipe.zcard = MagicMock(return_value=pipe)
        pipe.execute = AsyncMock(return_value=[0, 0, 0, 0])
        return pipe
    redis.pipeline = MagicMock(side_effect=side_effect)
    r = RateLimiter(redis, 20, 200)
    allowed, _ = await r.check_and_record("u1")
    assert allowed is True
    pipe2.zadd.assert_called()
