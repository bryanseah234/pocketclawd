"""
Tests for discovery_skill.py — new-user onboarding flow.

Requirements: 1.1, 1.2, 1.3, 1.4
"""

import json
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from src.persona.discovery_skill import (
    DEPTH_QUESTION,
    DOMAIN_QUESTION,
    INVALID_DEPTH_PROMPT,
    INVALID_DOMAIN_PROMPT,
    DiscoveryPhase,
    DiscoveryState,
    activate,
    handle_response,
    is_complete,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────


def make_redis() -> AsyncMock:
    r = AsyncMock()
    r.lpush = AsyncMock(return_value=1)
    return r


# ── activate() ───────────────────────────────────────────────────────────────


def test_activate_returns_state_and_depth_question():
    state, question = activate("user-1", "What is a Lambda function?")
    assert state.user_id == "user-1"
    assert state.original_message == "What is a Lambda function?"
    assert state.phase == DiscoveryPhase.DEPTH
    assert question == DEPTH_QUESTION


# ── handle_response — depth phase ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_valid_detailed_depth_advances_to_domain():
    redis = make_redis()
    state, _ = activate("user-1", "Q?")
    complete, msg, new_state = await handle_response(redis, state, "detailed")
    assert not complete
    assert msg == DOMAIN_QUESTION
    assert new_state.phase == DiscoveryPhase.DOMAIN
    assert new_state.technical_depth == "detailed"
    assert new_state.failed_attempts == 0


@pytest.mark.asyncio
async def test_valid_highlevel_depth_case_insensitive():
    redis = make_redis()
    state, _ = activate("user-1", "Q?")
    complete, msg, new_state = await handle_response(redis, state, "  High-Level  ")
    assert not complete
    assert new_state.technical_depth == "high-level"


@pytest.mark.asyncio
async def test_invalid_depth_retries_with_reprompt():
    redis = make_redis()
    state, _ = activate("user-1", "Q?")
    complete, msg, new_state = await handle_response(redis, state, "super-detailed")
    assert not complete
    assert msg == INVALID_DEPTH_PROMPT
    assert new_state.phase == DiscoveryPhase.DEPTH  # still waiting for depth
    assert new_state.failed_attempts == 1


@pytest.mark.asyncio
async def test_multiple_invalid_depth_increments_attempts():
    redis = make_redis()
    state, _ = activate("user-1", "Q?")
    for n in range(1, 4):
        _, _, state = await handle_response(redis, state, "gibberish")
        assert state.failed_attempts == n


# ── handle_response — domain phase ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_valid_domain_completes_and_stores_prefs():
    redis = make_redis()
    state, _ = activate("user-1", "Q?")
    # Advance to domain phase
    _, _, state = await handle_response(redis, state, "detailed")
    # Answer domain question
    complete, msg, final_state = await handle_response(redis, state, "frontend")
    assert complete
    assert final_state.phase == DiscoveryPhase.COMPLETE
    assert final_state.primary_domain == "frontend"
    # Should have called lpush to enqueue put_user_preference
    redis.lpush.assert_called_once()
    call_args = redis.lpush.call_args
    queue_key = call_args[0][0]
    payload = json.loads(call_args[0][1])
    assert queue_key == "queue:orchestrator:data_gateway"
    assert payload["action"] == "put_user_preference"
    assert payload["user_id"] == "user-1"
    assert payload["preferences"]["technical_depth"] == "detailed"
    assert payload["preferences"]["primary_domain"] == "frontend"
    assert payload["preferences"]["discoveryCompleted"] is True


@pytest.mark.asyncio
async def test_invalid_domain_retries():
    redis = make_redis()
    state, _ = activate("user-1", "Q?")
    _, _, state = await handle_response(redis, state, "high-level")
    complete, msg, new_state = await handle_response(redis, state, "mobile")
    assert not complete
    assert msg == INVALID_DOMAIN_PROMPT
    assert new_state.phase == DiscoveryPhase.DOMAIN
    assert new_state.failed_attempts == 1


@pytest.mark.asyncio
async def test_all_valid_domains_accepted():
    for domain in ("frontend", "infrastructure", "data"):
        redis = make_redis()
        state, _ = activate("user-1", "Q?")
        _, _, state = await handle_response(redis, state, "detailed")
        complete, _, final_state = await handle_response(redis, state, domain)
        assert complete, f"Expected complete=True for domain={domain}"
        assert final_state.primary_domain == domain


# ── Full flow ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_full_flow_stores_both_prefs_and_signals_resume():
    redis = make_redis()
    state, depth_q = activate("user-99", "Help me debug this Lambda.")
    assert not is_complete(state)

    # Q1: depth
    complete, msg, state = await handle_response(redis, state, "high-level")
    assert not complete
    assert not is_complete(state)

    # Q2: domain
    complete, ack, state = await handle_response(redis, state, "infrastructure")
    assert complete
    assert is_complete(state)
    assert "high-level" in ack
    assert "infrastructure" in ack
    # Original question reference in ack
    assert "back to your question" in ack.lower() or "\u2026" in ack


@pytest.mark.asyncio
async def test_redis_failure_does_not_raise(caplog):
    """Best-effort storage: Redis error should not propagate to caller."""
    redis = make_redis()
    redis.lpush.side_effect = Exception("connection lost")
    state, _ = activate("user-1", "Q?")
    _, _, state = await handle_response(redis, state, "detailed")
    # Should not raise
    complete, _, final_state = await handle_response(redis, state, "data")
    assert complete  # flow completes even if storage fails
