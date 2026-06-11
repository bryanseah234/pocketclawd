"""
Discovery Phase Skill -- guides new users through 3-question personal onboarding.

Questions:
  1. Name        -- what to call them
  2. Primary use -- reminders/docs/journaling/everything
  3. Reply style -- short & snappy / more detail

State is persisted in Redis hash `discovery:{userId}` so it survives across
stateless sub-agent restarts. Once complete, preferences are stored via
DataGateway Worker to DynamoDB user_preferences.
"""
from __future__ import annotations

import json
import logging
import secrets
from dataclasses import dataclass
from enum import Enum

from redis.asyncio import Redis
from redis.exceptions import RedisError

logger = logging.getLogger(__name__)

DATA_GATEWAY_QUEUE = "queue:orchestrator:data_gateway"
PREFERENCE_TIMEOUT_SECONDS = 5
REDIS_STATE_TTL = 3600  # 1 hour - drop stale discovery sessions

USE_LABELS = {
    "1": "reminders & errands",
    "2": "documents & notes",
    "3": "journaling & brain-dumps",
    "4": "a bit of everything",
}
VALID_STYLE = frozenset({"short", "detailed"})


class DiscoveryPhase(Enum):
    NAME = "name"
    USE = "use"
    STYLE = "style"
    COMPLETE = "complete"


@dataclass
class DiscoveryState:
    user_id: str
    original_message: str
    phase: DiscoveryPhase = DiscoveryPhase.NAME
    user_name: str | None = None
    primary_use: str | None = None
    reply_style: str | None = None
    failed_attempts: int = 0


NAME_QUESTION = (
    "Hey! First things first -- what should I call you? "
    "(Just your first name is fine \U0001f60a)"
)

USE_QUESTION = (
    "Nice to meet you, {name}! What do you mainly want help with?\n\n"
    "\u2022 *1* -- Reminders & errands\n"
    "\u2022 *2* -- Documents & notes\n"
    "\u2022 *3* -- Journaling & brain-dumps\n"
    "\u2022 *4* -- A bit of everything\n\n"
    "Just reply with the number."
)

STYLE_QUESTION = (
    "Last one -- how do you like replies?\n\n"
    "\u2022 *short* -- quick & snappy\n"
    "\u2022 *detailed* -- more context\n\n"
    "Just reply with one of the two."
)

INVALID_USE = "Just reply with *1*, *2*, *3*, or *4* -- which fits best?"
INVALID_STYLE = "Just reply with *short* or *detailed*."

COMPLETE_ACK = (
    "Got it! I'll remember you as *{name}*, focused on *{use}*, "
    "with *{style}* replies. Now -- back to your question..."
)

COMPLETE_ACK_NO_Q = (
    "Perfect \U0001f44c I've got you down as *{name}*, focused on *{use}*, "
    "*{style}* replies. What can I help you with today?"
)


def _state_key(user_id: str) -> str:
    return f"discovery:{user_id}"


async def load_state(redis: Redis, user_id: str) -> DiscoveryState | None:
    try:
        raw = await redis.hgetall(_state_key(user_id))
        if not raw:
            return None
        phase_str = raw.get("phase", "name")
        try:
            phase = DiscoveryPhase(phase_str)
        except ValueError:
            phase = DiscoveryPhase.NAME
        return DiscoveryState(
            user_id=user_id,
            original_message=raw.get("original_message", ""),
            phase=phase,
            user_name=raw.get("user_name") or None,
            primary_use=raw.get("primary_use") or None,
            reply_style=raw.get("reply_style") or None,
            failed_attempts=int(raw.get("failed_attempts", 0)),
        )
    except RedisError as e:
        logger.warning("Failed to load discovery state for %s: %s", user_id, e)
        return None


async def save_state(redis: Redis, state: DiscoveryState) -> None:
    key = _state_key(state.user_id)
    data = {
        "phase": state.phase.value,
        "original_message": state.original_message,
        "user_name": state.user_name or "",
        "primary_use": state.primary_use or "",
        "reply_style": state.reply_style or "",
        "failed_attempts": str(state.failed_attempts),
    }
    try:
        await redis.hset(key, mapping=data)
        await redis.expire(key, REDIS_STATE_TTL)
    except RedisError as e:
        logger.warning("Failed to save discovery state for %s: %s", state.user_id, e)


async def clear_state(redis: Redis, user_id: str) -> None:
    try:
        await redis.delete(_state_key(user_id))
    except RedisError:
        pass


def activate(user_id: str, original_message: str) -> tuple[DiscoveryState, str]:
    """Start discovery for a new user. Returns (state, first_question)."""
    state = DiscoveryState(user_id=user_id, original_message=original_message)
    return state, NAME_QUESTION


async def handle_response(
    redis: Redis,
    state: DiscoveryState,
    response_text: str,
) -> tuple[bool, str, DiscoveryState]:
    """
    Process user reply for current phase.
    Returns (complete, message_to_send, updated_state).
    complete=False: still in discovery.
    complete=True:  all prefs captured, resume chat.
    """
    token = response_text.strip().lower()

    if state.phase == DiscoveryPhase.NAME:
        name = response_text.strip()[:50] if response_text.strip() else "there"
        state.user_name = name.capitalize() if name.islower() else name
        state.phase = DiscoveryPhase.USE
        state.failed_attempts = 0
        await save_state(redis, state)
        return False, USE_QUESTION.format(name=state.user_name), state

    if state.phase == DiscoveryPhase.USE:
        if token not in USE_LABELS:
            state.failed_attempts += 1
            await save_state(redis, state)
            return False, INVALID_USE, state
        state.primary_use = USE_LABELS[token]
        state.phase = DiscoveryPhase.STYLE
        state.failed_attempts = 0
        await save_state(redis, state)
        return False, STYLE_QUESTION, state

    if state.phase == DiscoveryPhase.STYLE:
        if token not in VALID_STYLE:
            state.failed_attempts += 1
            await save_state(redis, state)
            return False, INVALID_STYLE, state
        state.reply_style = token
        state.phase = DiscoveryPhase.COMPLETE
        state.failed_attempts = 0
        await _store_preferences(redis, state)
        await clear_state(redis, state.user_id)
        if state.original_message.strip():
            ack = COMPLETE_ACK.format(
                name=state.user_name,
                use=state.primary_use,
                style=state.reply_style,
            )
        else:
            ack = COMPLETE_ACK_NO_Q.format(
                name=state.user_name,
                use=state.primary_use,
                style=state.reply_style,
            )
        return True, ack, state

    return True, "", state


def is_complete(state: DiscoveryState) -> bool:
    return state.phase == DiscoveryPhase.COMPLETE


async def _store_preferences(redis: Redis, state: DiscoveryState) -> None:
    request_id = secrets.token_hex(8)
    payload = {
        "action": "put_user_preference",
        "user_id": state.user_id,
        "request_id": request_id,
        "preferences": {
            "user_name": state.user_name,
            "primary_use": state.primary_use,
            "reply_style": state.reply_style,
            "discoveryCompleted": True,
        },
    }
    try:
        await redis.lpush(DATA_GATEWAY_QUEUE, json.dumps(payload))
        logger.info("Discovery preferences queued for %s", state.user_id)
    except Exception as exc:
        logger.error("Failed to persist discovery preferences for %s: %s", state.user_id, exc)
