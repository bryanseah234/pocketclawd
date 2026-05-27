"""
Discovery Phase Skill — guides new users through the two-question onboarding flow.

When a user is detected as new (no stored preferences / discoveryCompleted=False),
this skill activates and asks exactly two questions:
  1. Technical depth preference: "detailed" | "high-level"
  2. Primary domain:             "frontend" | "infrastructure" | "data"

Responses are validated against the allowed enum values. Invalid answers trigger
a re-ask for the specific question. Once both preferences are captured they are
persisted via a put_user_preference request to the DataGateway Worker, and the
skill signals the main loop to resume answering the user's original question.

Requirements: 1.1, 1.2, 1.3, 1.4
"""

import json
import logging
import secrets
from dataclasses import dataclass, field
from enum import Enum

from redis.asyncio import Redis
from redis.exceptions import RedisError

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

DATA_GATEWAY_QUEUE = "queue:orchestrator:data_gateway"
PREFERENCE_TIMEOUT_SECONDS = 5

VALID_TECHNICAL_DEPTH = frozenset({"detailed", "high-level"})
VALID_PRIMARY_DOMAIN = frozenset({"frontend", "infrastructure", "data"})


# ── Data models ───────────────────────────────────────────────────────────────


class DiscoveryPhase(Enum):
    """Which discovery question is currently awaiting a user response."""

    DEPTH = "depth"
    DOMAIN = "domain"
    COMPLETE = "complete"


@dataclass
class DiscoveryState:
    """
    Tracks progress through the two-question discovery flow for one user.

    Instances are ephemeral (held in the agent-runner session loop, not persisted).
    """

    user_id: str
    original_message: str
    phase: DiscoveryPhase = DiscoveryPhase.DEPTH
    technical_depth: str | None = None
    primary_domain: str | None = None
    failed_attempts: int = 0  # consecutive invalid answers; reset on phase advance


# ── Discovery questions ───────────────────────────────────────────────────────

DEPTH_QUESTION = (
    "To give you the most useful answers, I'd like to know your preference:\n\n"
    "How do you prefer technical explanations?\n"
    "  • *detailed* — in-depth, with implementation specifics\n"
    "  • *high-level* — concise overview, less jargon\n\n"
    "Just reply with one of the two options."
)

DOMAIN_QUESTION = (
    "One more quick question — which area best describes your primary focus?\n\n"
    "  • *frontend* — UI, browsers, client-side\n"
    "  • *infrastructure* — cloud, DevOps, systems\n"
    "  • *data* — databases, analytics, data engineering\n\n"
    "Just reply with one of the three options."
)

INVALID_DEPTH_PROMPT = (
    "I didn't quite catch that. Please reply with either *detailed* or *high-level*."
)

INVALID_DOMAIN_PROMPT = (
    "I didn't quite catch that. "
    "Please reply with *frontend*, *infrastructure*, or *data*."
)


# ── Public API ────────────────────────────────────────────────────────────────


def activate(user_id: str, original_message: str) -> tuple[DiscoveryState, str]:
    """
    Start the discovery flow for a new user.

    Returns:
        (state, question_text) — state tracks progress; question_text should be
        sent to the user as the agent's reply.
    """
    state = DiscoveryState(user_id=user_id, original_message=original_message)
    return state, DEPTH_QUESTION


async def handle_response(
    redis: Redis,
    state: DiscoveryState,
    response_text: str,
) -> tuple[bool, str, DiscoveryState]:
    """
    Process the user's reply to the current discovery question.

    Returns:
        (complete, message, updated_state)
        - complete=False, message=re-ask text  → invalid answer, re-prompt
        - complete=False, message=next question → advance to next phase
        - complete=True,  message=ack text      → both prefs captured and stored
    """
    token = response_text.strip().lower()

    if state.phase == DiscoveryPhase.DEPTH:
        if token not in VALID_TECHNICAL_DEPTH:
            state.failed_attempts += 1
            return False, INVALID_DEPTH_PROMPT, state

        state.technical_depth = token
        state.phase = DiscoveryPhase.DOMAIN
        state.failed_attempts = 0
        return False, DOMAIN_QUESTION, state

    if state.phase == DiscoveryPhase.DOMAIN:
        if token not in VALID_PRIMARY_DOMAIN:
            state.failed_attempts += 1
            return False, INVALID_DOMAIN_PROMPT, state

        state.primary_domain = token
        state.phase = DiscoveryPhase.COMPLETE
        state.failed_attempts = 0

        # Persist preferences via DataGateway Worker
        await _store_preferences(redis, state)

        ack = (
            f"Got it — *{state.technical_depth}* depth, *{state.primary_domain}* focus. "
            "I'll keep that in mind for all our conversations. "
            "Now, back to your question\u2026"
        )
        return True, ack, state

    # Should not reach here (phase=COMPLETE) — treat as no-op
    return True, "", state


def is_complete(state: DiscoveryState) -> bool:
    """Return True when both preferences have been captured."""
    return state.phase == DiscoveryPhase.COMPLETE


# ── Internal helpers ──────────────────────────────────────────────────────────


async def _store_preferences(redis: Redis, state: DiscoveryState) -> None:
    """
    Send a put_user_preference request to the DataGateway Worker via Redis.

    Best-effort: logs on failure but does not raise (the discovery UX has
    already confirmed to the user; we don't want to break the session).
    """
    request_id = secrets.token_hex(8)
    payload = {
        "action": "put_user_preference",
        "user_id": state.user_id,
        "request_id": request_id,
        "preferences": {
            "technical_depth": state.technical_depth,
            "primary_domain": state.primary_domain,
            "discoveryCompleted": True,
        },
    }

    try:
        await redis.lpush(DATA_GATEWAY_QUEUE, json.dumps(payload))
        logger.info(
            "Discovery preferences enqueued for persistence",
            extra={"user_id": state.user_id, "request_id": request_id},
        )
    except (RedisError, Exception) as exc:  # noqa: BLE001
        logger.error(
            "Failed to persist discovery preferences (best-effort, session continues)",
            extra={"user_id": state.user_id, "error": str(exc)},
        )
