"""
Tests for discovery_skill.py -- new-user onboarding flow.

Covers the 3-question flow: NAME -> USE -> STYLE -> COMPLETE.
(Rewritten to match the current name/use/style API; the prior version targeted
a superseded depth/domain flow.)
"""

from unittest.mock import AsyncMock

import pytest

from src.persona.discovery_skill import (
    COMPLETE_ACK,
    COMPLETE_ACK_NO_Q,
    INVALID_STYLE,
    INVALID_USE,
    NAME_QUESTION,
    STYLE_QUESTION,
    USE_LABELS,
    USE_QUESTION,
    DiscoveryPhase,
    DiscoveryState,
    activate,
    handle_response,
    is_complete,
)


def make_redis() -> AsyncMock:
    r = AsyncMock()
    r.lpush = AsyncMock(return_value=1)
    r.hset = AsyncMock(return_value=1)
    r.expire = AsyncMock(return_value=True)
    r.delete = AsyncMock(return_value=1)
    return r


def test_activate_returns_state_and_name_question():
    state, question = activate("user-1", "What is a Lambda function?")
    assert state.user_id == "user-1"
    assert state.original_message == "What is a Lambda function?"
    assert state.phase == DiscoveryPhase.NAME
    assert question == NAME_QUESTION


@pytest.mark.asyncio
async def test_name_capitalized_and_advances_to_use():
    redis = make_redis()
    state, _ = activate("user-1", "Q?")
    complete, msg, new_state = await handle_response(redis, state, "bryan")
    assert not complete
    assert new_state.user_name == "Bryan"
    assert new_state.phase == DiscoveryPhase.USE
    assert msg == USE_QUESTION.format(name="Bryan")
    redis.hset.assert_awaited()


@pytest.mark.asyncio
async def test_blank_name_falls_back_to_there():
    redis = make_redis()
    state, _ = activate("user-1", "Q?")
    _, _, new_state = await handle_response(redis, state, "   ")
    assert new_state.user_name == "There"
    assert new_state.phase == DiscoveryPhase.USE


@pytest.mark.asyncio
async def test_valid_use_advances_to_style():
    redis = make_redis()
    state = DiscoveryState(user_id="u1", original_message="Q?", phase=DiscoveryPhase.USE, user_name="Bryan")
    complete, msg, new_state = await handle_response(redis, state, "2")
    assert not complete
    assert new_state.primary_use == USE_LABELS["2"]
    assert new_state.phase == DiscoveryPhase.STYLE
    assert msg == STYLE_QUESTION


@pytest.mark.asyncio
async def test_invalid_use_reprompts_and_increments_failures():
    redis = make_redis()
    state = DiscoveryState(user_id="u1", original_message="Q?", phase=DiscoveryPhase.USE, user_name="Bryan")
    complete, msg, new_state = await handle_response(redis, state, "banana")
    assert not complete
    assert msg == INVALID_USE
    assert new_state.phase == DiscoveryPhase.USE
    assert new_state.failed_attempts == 1


@pytest.mark.asyncio
async def test_valid_style_completes_with_original_question():
    redis = make_redis()
    state = DiscoveryState(
        user_id="u1", original_message="What is a Lambda?", phase=DiscoveryPhase.STYLE,
        user_name="Bryan", primary_use=USE_LABELS["2"],
    )
    complete, msg, new_state = await handle_response(redis, state, "short")
    assert complete
    assert new_state.phase == DiscoveryPhase.COMPLETE
    assert new_state.reply_style == "short"
    assert msg == COMPLETE_ACK.format(name="Bryan", use=USE_LABELS["2"], style="short")
    redis.lpush.assert_awaited()
    redis.delete.assert_awaited()


@pytest.mark.asyncio
async def test_valid_style_completes_without_original_question():
    redis = make_redis()
    state = DiscoveryState(
        user_id="u1", original_message="", phase=DiscoveryPhase.STYLE,
        user_name="Bryan", primary_use=USE_LABELS["1"],
    )
    complete, msg, _ = await handle_response(redis, state, "detailed")
    assert complete
    assert msg == COMPLETE_ACK_NO_Q.format(name="Bryan", use=USE_LABELS["1"], style="detailed")


@pytest.mark.asyncio
async def test_invalid_style_reprompts():
    redis = make_redis()
    state = DiscoveryState(
        user_id="u1", original_message="Q?", phase=DiscoveryPhase.STYLE,
        user_name="Bryan", primary_use=USE_LABELS["3"],
    )
    complete, msg, new_state = await handle_response(redis, state, "medium")
    assert not complete
    assert msg == INVALID_STYLE
    assert new_state.phase == DiscoveryPhase.STYLE


def test_is_complete_true_only_when_phase_complete():
    s = DiscoveryState(user_id="u1", original_message="Q?")
    assert not is_complete(s)
    s.phase = DiscoveryPhase.COMPLETE
    assert is_complete(s)


@pytest.mark.asyncio
async def test_full_flow_name_use_style():
    redis = make_redis()
    state, q1 = activate("u1", "How do I deploy?")
    assert q1 == NAME_QUESTION
    _, q2, state = await handle_response(redis, state, "Sam")
    assert q2 == USE_QUESTION.format(name="Sam")
    _, q3, state = await handle_response(redis, state, "4")
    assert q3 == STYLE_QUESTION
    complete, ack, state = await handle_response(redis, state, "detailed")
    assert complete
    assert is_complete(state)
    assert state.user_name == "Sam"
    assert state.primary_use == USE_LABELS["4"]
    assert state.reply_style == "detailed"
