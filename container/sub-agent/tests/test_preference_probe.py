"""
Unit tests for preference_probe.py — DataGateway preference query module.

Requirements: 1.1 (new-user detection), 7.1 (fail-open behavior).
"""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError, RedisError, TimeoutError

from src.persona.preference_probe import (
    DATA_GATEWAY_QUEUE,
    PROBE_TIMEOUT_SECONDS,
    UserPersonaContext,
    _default_context,
    _parse_preferences,
    probe_user_preferences,
)


# ── _default_context ────────────────────────────────────────────────────────


def test_default_context_is_new_user():
    ctx = _default_context()
    assert ctx.is_new_user is True
    assert ctx.technical_depth is None
    assert ctx.primary_domain is None


# ── _parse_preferences ──────────────────────────────────────────────────────


def test_parse_none_returns_new_user():
    ctx = _parse_preferences(None)
    assert ctx.is_new_user is True
    assert ctx.technical_depth is None
    assert ctx.primary_domain is None


def test_parse_missing_discovery_flag_returns_new_user():
    ctx = _parse_preferences({"technical_depth": "detailed"})
    assert ctx.is_new_user is True
    assert ctx.technical_depth is None  # ignored when discovery not complete
    assert ctx.primary_domain is None


def test_parse_discovery_false_returns_new_user():
    ctx = _parse_preferences(
        {
            "discoveryCompleted": False,
            "technical_depth": "detailed",
            "primary_domain": "frontend",
        }
    )
    assert ctx.is_new_user is True
    assert ctx.technical_depth is None
    assert ctx.primary_domain is None


def test_parse_completed_with_valid_values():
    ctx = _parse_preferences(
        {
            "discoveryCompleted": True,
            "technical_depth": "detailed",
            "primary_domain": "infrastructure",
        }
    )
    assert ctx.is_new_user is False
    assert ctx.technical_depth == "detailed"
    assert ctx.primary_domain == "infrastructure"


@pytest.mark.parametrize("depth", ["detailed", "high-level"])
def test_parse_valid_technical_depth(depth):
    ctx = _parse_preferences(
        {"discoveryCompleted": True, "technical_depth": depth, "primary_domain": "data"}
    )
    assert ctx.technical_depth == depth


def test_parse_invalid_technical_depth_becomes_none():
    ctx = _parse_preferences(
        {
            "discoveryCompleted": True,
            "technical_depth": "EXTRA-VERBOSE",
            "primary_domain": "data",
        }
    )
    assert ctx.is_new_user is False
    assert ctx.technical_depth is None
    assert ctx.primary_domain == "data"


@pytest.mark.parametrize("domain", ["frontend", "infrastructure", "data"])
def test_parse_valid_primary_domain(domain):
    ctx = _parse_preferences(
        {"discoveryCompleted": True, "technical_depth": "detailed", "primary_domain": domain}
    )
    assert ctx.primary_domain == domain


def test_parse_invalid_primary_domain_becomes_none():
    ctx = _parse_preferences(
        {
            "discoveryCompleted": True,
            "technical_depth": "detailed",
            "primary_domain": "blockchain",
        }
    )
    assert ctx.is_new_user is False
    assert ctx.primary_domain is None
    assert ctx.technical_depth == "detailed"


def test_parse_completed_with_missing_fields():
    ctx = _parse_preferences({"discoveryCompleted": True})
    assert ctx.is_new_user is False
    assert ctx.technical_depth is None
    assert ctx.primary_domain is None


# ── probe_user_preferences (integration with mocked Redis) ──────────────────


def _make_redis_mock(brpop_result):
    redis = MagicMock()
    redis.lpush = AsyncMock(return_value=1)
    redis.brpop = AsyncMock(return_value=brpop_result)
    return redis


@pytest.mark.asyncio
async def test_probe_returning_user_with_full_preferences():
    payload = json.dumps(
        {
            "success": True,
            "preferences": {
                "discoveryCompleted": True,
                "technical_depth": "high-level",
                "primary_domain": "frontend",
            },
        }
    )
    redis = _make_redis_mock((b"key", payload))

    ctx = await probe_user_preferences(redis, "user-42")

    assert ctx.is_new_user is False
    assert ctx.technical_depth == "high-level"
    assert ctx.primary_domain == "frontend"
    redis.lpush.assert_awaited_once()
    queue_arg, body_arg = redis.lpush.call_args.args
    assert queue_arg == DATA_GATEWAY_QUEUE
    body = json.loads(body_arg)
    assert body["action"] == "get_user_preference"
    assert body["user_id"] == "user-42"
    assert "request_id" in body and len(body["request_id"]) > 0


@pytest.mark.asyncio
async def test_probe_no_record_returns_new_user():
    payload = json.dumps({"success": True, "preferences": None})
    redis = _make_redis_mock((b"key", payload))

    ctx = await probe_user_preferences(redis, "user-42")

    assert ctx.is_new_user is True
    assert ctx.technical_depth is None
    assert ctx.primary_domain is None


@pytest.mark.asyncio
async def test_probe_timeout_fails_open():
    redis = _make_redis_mock(None)  # brpop returns None on timeout

    ctx = await probe_user_preferences(redis, "user-timeout")

    assert ctx.is_new_user is True
    redis.brpop.assert_awaited_once()
    # Verify the BRPOP timeout matches the constant — support positional or kw
    call = redis.brpop.call_args
    timeout = call.kwargs.get("timeout") if "timeout" in call.kwargs else call.args[1]
    assert timeout == PROBE_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_probe_dg_error_response_fails_open():
    payload = json.dumps({"success": False, "error": "table-not-found"})
    redis = _make_redis_mock((b"key", payload))

    ctx = await probe_user_preferences(redis, "user-42")

    assert ctx.is_new_user is True


@pytest.mark.asyncio
async def test_probe_redis_error_fails_open():
    redis = MagicMock()
    redis.lpush = AsyncMock(side_effect=RedisConnectionError("redis down"))
    redis.brpop = AsyncMock()

    ctx = await probe_user_preferences(redis, "user-42")

    assert ctx.is_new_user is True
    redis.brpop.assert_not_awaited()


@pytest.mark.asyncio
async def test_probe_brpop_redis_error_fails_open():
    redis = MagicMock()
    redis.lpush = AsyncMock(return_value=1)
    redis.brpop = AsyncMock(side_effect=TimeoutError("upstream timeout"))

    ctx = await probe_user_preferences(redis, "user-42")
    assert ctx.is_new_user is True


@pytest.mark.asyncio
async def test_probe_malformed_json_fails_open():
    redis = _make_redis_mock((b"key", "not-json{"))

    ctx = await probe_user_preferences(redis, "user-42")

    assert ctx.is_new_user is True


@pytest.mark.asyncio
async def test_probe_unexpected_exception_fails_open():
    redis = MagicMock()
    redis.lpush = AsyncMock(return_value=1)
    redis.brpop = AsyncMock(side_effect=RuntimeError("kaboom"))

    ctx = await probe_user_preferences(redis, "user-42")

    assert ctx.is_new_user is True


@pytest.mark.asyncio
async def test_probe_uses_per_user_response_queue():
    payload = json.dumps({"success": True, "preferences": None})
    redis = _make_redis_mock((b"key", payload))

    await probe_user_preferences(redis, "user-7")

    call = redis.brpop.call_args
    response_key = call.args[0]
    assert response_key.startswith("queue:agent:user-7:dg_response:")


@pytest.mark.asyncio
async def test_probe_request_ids_are_unique_per_call():
    payload = json.dumps({"success": True, "preferences": None})
    redis = _make_redis_mock((b"key", payload))
    # Each lpush body should carry a fresh request_id
    request_ids = []

    async def capture_lpush(queue, body):
        request_ids.append(json.loads(body)["request_id"])
        return 1

    redis.lpush = AsyncMock(side_effect=capture_lpush)

    await probe_user_preferences(redis, "u1")
    await probe_user_preferences(redis, "u1")
    await probe_user_preferences(redis, "u1")

    assert len(set(request_ids)) == 3
