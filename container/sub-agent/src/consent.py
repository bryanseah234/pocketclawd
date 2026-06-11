"""
PDPA consent collection module for the Clawd sub-agent.
Tracks user consent status in Redis and enforces annual renewal.
"""
import json
import logging
from datetime import datetime, timezone, timedelta

from redis.asyncio import Redis

logger = logging.getLogger(__name__)

CONSENT_KEY_PREFIX = "consent:"
CONSENT_VERSION = "1.0"
CONSENT_TTL_SECONDS = 400 * 24 * 3600  # ~13 months, ensure annual renewal
RENEWAL_THRESHOLD_DAYS = 335  # ~11 months

CONSENT_MESSAGE = (
    "Hey 👋 I store messages so I can help you better (PDPA-protected, /forget anytime). Reply *yes* to start or *no* to decline."
)

CONSENT_GRANTED_MESSAGE = (
    "Thank you! You're all set. How can I help you today? 😊"
)

CONSENT_DECLINED_MESSAGE = (
    "Understood. Without consent I cannot store your messages or provide "
    "personalised responses. If you change your mind, just message me again."
)

CONSENT_RE_ASK = (
    "Please reply with *yes* to consent or *no* to decline.\n"
    "Type /privacy for full details about how your data is used."
)

RENEWAL_MESSAGE = (
    "⚠️ *Annual data consent renewal*\n\n"
    "It's been almost a year since you gave consent for data processing. "
    "Please renew your consent to continue using Clawd.\n\n"
    "Reply *yes* to renew or *no* to withdraw consent."
)

WITHDRAWAL_MESSAGE = (
    "✅ Your consent has been withdrawn and all your data will be deleted. "
    "Thank you for using Clawd."
)


def _key(user_id: str) -> str:
    return f"{CONSENT_KEY_PREFIX}{user_id}"


async def needs_consent(redis: Redis, user_id: str) -> bool:
    """True if user has not yet given consent or consent is expired (>1 year)."""
    raw = await redis.hgetall(_key(user_id))
    if not raw:
        return True
    status = raw.get("status", "pending")
    if status in ("declined", "withdrawn"):
        return True
    if status != "granted":
        return True
    # Check expiry
    ts_str = raw.get("timestamp")
    if not ts_str:
        return True
    try:
        ts = datetime.fromisoformat(ts_str)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        age_days = (datetime.now(timezone.utc) - ts).days
        if age_days >= 365:
            return True
    except ValueError:
        return True
    return False


async def record_consent(redis: Redis, user_id: str, granted: bool) -> None:
    """Store consent decision with timestamp and version in Redis hash."""
    data = {
        "status": "granted" if granted else "declined",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "version": CONSENT_VERSION,
        "user_id": user_id,
    }
    await redis.hset(_key(user_id), mapping=data)
    if granted:
        await redis.expire(_key(user_id), CONSENT_TTL_SECONDS)


async def withdraw_consent(redis: Redis, user_id: str) -> str:
    """Mark consent as withdrawn and return confirmation message."""
    data = {
        "status": "withdrawn",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "version": CONSENT_VERSION,
        "user_id": user_id,
    }
    await redis.hset(_key(user_id), mapping=data)
    await redis.expire(_key(user_id), 86400)  # Keep record for 24h then purge
    return WITHDRAWAL_MESSAGE


async def handle_consent_response(
    redis: Redis, user_id: str, content: str
) -> tuple[bool | None, str]:
    """
    If user is in consent flow, process their response.
    Returns:
        (True, welcome_msg)  — consented
        (False, decline_msg) — declined
        (None, re_ask)       — unrecognised, re-ask
        (None, '')           — not in consent flow
    """
    pending = await redis.hget(_key(user_id), "status")
    if pending not in (None, "pending", "renewal_pending"):
        # Not in an active consent flow
        in_flow = await needs_consent(redis, user_id)
        if not in_flow:
            return (None, "")

    normalized = content.strip().lower()
    if normalized in ("yes", "y", "agree", "consent", "ok"):
        await record_consent(redis, user_id, granted=True)
        return (True, CONSENT_GRANTED_MESSAGE)
    if normalized in ("no", "n", "decline", "disagree"):
        await record_consent(redis, user_id, granted=False)
        return (False, CONSENT_DECLINED_MESSAGE)
    return (None, CONSENT_RE_ASK)


async def check_annual_renewal(redis: Redis, user_id: str) -> str | None:
    """Return renewal reminder if consent is >11 months old, else None."""
    raw = await redis.hgetall(_key(user_id))
    if not raw or raw.get("status") != "granted":
        return None
    ts_str = raw.get("timestamp")
    if not ts_str:
        return None
    try:
        ts = datetime.fromisoformat(ts_str)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        age_days = (datetime.now(timezone.utc) - ts).days
        if age_days >= RENEWAL_THRESHOLD_DAYS:
            # Mark as renewal_pending
            await redis.hset(_key(user_id), "status", "renewal_pending")
            return RENEWAL_MESSAGE
    except ValueError:
        pass
    return None
