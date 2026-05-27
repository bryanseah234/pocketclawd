"""
Preference Probe — queries DataGateway for user preferences via Redis queue.

Used during session initialization to determine whether a user is new
(needs discovery phase) or returning (gets context-aware greeting).

Implements fail-open behavior: any error (timeout, parse failure, Redis
connection loss) returns is_new_user=True so the user always gets a
functional experience.
"""

import json
import logging
import secrets
from dataclasses import dataclass
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import RedisError

logger = logging.getLogger(__name__)

# Redis queue used by the DataGateway Worker
DATA_GATEWAY_QUEUE = "queue:orchestrator:data_gateway"

# Timeout (seconds) for waiting on DataGateway response
PROBE_TIMEOUT_SECONDS = 5


@dataclass
class UserPersonaContext:
    """Context derived from stored preferences for prompt injection."""

    is_new_user: bool
    technical_depth: str | None  # "detailed" | "high-level"
    primary_domain: str | None  # "frontend" | "infrastructure" | "data"


def _default_context() -> UserPersonaContext:
    """Return the fail-open default: treat as new user with no preferences."""
    return UserPersonaContext(
        is_new_user=True,
        technical_depth=None,
        primary_domain=None,
    )


def _parse_preferences(preferences: dict[str, Any] | None) -> UserPersonaContext:
    """
    Parse a preferences dict from DataGateway into a UserPersonaContext.

    Returns is_new_user=True when:
      - preferences is None (no record in DynamoDB)
      - discoveryCompleted is absent or False

    Returns is_new_user=False with populated fields when:
      - discoveryCompleted is True
    """
    if preferences is None:
        return _default_context()

    discovery_completed = preferences.get("discoveryCompleted", False)

    if not discovery_completed:
        return _default_context()

    # User has completed discovery — extract their preferences
    technical_depth = preferences.get("technical_depth")
    primary_domain = preferences.get("primary_domain")

    return UserPersonaContext(
        is_new_user=False,
        technical_depth=technical_depth if technical_depth in ("detailed", "high-level") else None,
        primary_domain=primary_domain if primary_domain in ("frontend", "infrastructure", "data") else None,
    )


async def probe_user_preferences(redis: Redis, user_id: str) -> UserPersonaContext:
    """
    Query DataGateway for user preferences. Returns context for prompt assembly.

    Sends a `get_user_preference` request to the DataGateway Worker via Redis
    queue and waits for the response with a timeout.

    Fail-open: on any error (timeout, parse error, Redis connection error),
    returns UserPersonaContext(is_new_user=True, ...) so the user always
    enters the discovery phase rather than being blocked.
    """
    try:
        request_id = secrets.token_hex(8)

        request = {
            "action": "get_user_preference",
            "user_id": user_id,
            "request_id": request_id,
        }

        # Send request to DataGateway Worker
        await redis.lpush(DATA_GATEWAY_QUEUE, json.dumps(request))

        # Wait for response on the per-user response queue
        response_key = f"queue:agent:{user_id}:dg_response:{request_id}"
        result = await redis.brpop(response_key, timeout=PROBE_TIMEOUT_SECONDS)

        if result is None:
            # Timeout — DataGateway didn't respond in time
            logger.warning(
                "Preference probe timed out for user_id=%s (timeout=%ds)",
                user_id,
                PROBE_TIMEOUT_SECONDS,
            )
            return _default_context()

        _key, raw = result
        response = json.loads(raw)

        if not response.get("success", False):
            # DataGateway returned an error
            error_msg = response.get("error", "unknown error")
            logger.warning(
                "Preference probe failed for user_id=%s: %s",
                user_id,
                error_msg,
            )
            return _default_context()

        preferences = response.get("preferences")
        return _parse_preferences(preferences)

    except RedisError as e:
        logger.error(
            "Redis error during preference probe for user_id=%s: %s",
            user_id,
            str(e),
        )
        return _default_context()

    except (json.JSONDecodeError, TypeError, KeyError) as e:
        logger.error(
            "Parse error during preference probe for user_id=%s: %s",
            user_id,
            str(e),
        )
        return _default_context()

    except Exception as e:
        logger.error(
            "Unexpected error during preference probe for user_id=%s: %s",
            user_id,
            str(e),
            exc_info=True,
        )
        return _default_context()
