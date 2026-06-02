"""
Reminders -- schedule future WhatsApp messages, no OAuth required.

Storage: Redis sorted set  key=reminders:{userId}  score=unix_timestamp  member=JSON
Delivery: background loop every 30s fires due reminders via orchestrator response queue.

Commands (handled in commands.py):
  /remind me to <text> at <time>
  /remind me to <text> in <duration>
  /reminders            -- list pending
  /remindclear <id>     -- cancel one
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

SGT = timezone(timedelta(hours=8))
REMINDERS_PREFIX = "reminders:"
RESPONSE_QUEUE = "queue:orchestrator:responses"

_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _apply_time_of_day(base: datetime, s: str) -> datetime | None:
    s = s.strip()
    if not s:
        return None
    m = re.match(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", s)
    if not m:
        return None
    h = int(m.group(1))
    mins = int(m.group(2) or 0)
    ampm = m.group(3)
    if ampm == "pm" and h < 12:
        h += 12
    elif ampm == "am" and h == 12:
        h = 0
    if 0 <= h <= 23 and 0 <= mins <= 59:
        return base.replace(hour=h, minute=mins, second=0, microsecond=0)
    return None


def _parse_time_str(time_str: str, now: datetime) -> datetime | None:
    s = time_str.strip().lower()

    # Strip a leading "at " prefix (comes from parse_remind_command splitting
    # on " at " and prepending "at " back, e.g. "at 3pm", "at 9am", "at 3pm today")
    import re as _re
    s = _re.sub(r"^at\s+", "", s)

    # "in X minutes/hours/days/weeks"
    m = re.match(r"in\s+(\d+)\s*(min(?:ute)?s?|h(?:our)?s?|days?|weeks?)", s)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        if unit.startswith("min"):
            return now + timedelta(minutes=n)
        if unit.startswith("h"):
            return now + timedelta(hours=n)
        if unit.startswith("d"):
            return now + timedelta(days=n)
        if unit.startswith("w"):
            return now + timedelta(weeks=n)

    # "tomorrow [at HH:MM]"
    if s.startswith("tomorrow"):
        base = (now + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
        rest = s[len("tomorrow"):].strip().lstrip("at").strip()
        return _apply_time_of_day(base, rest) or base

    # "today [at HH:MM]"
    if s.startswith("today"):
        base = now.replace(second=0, microsecond=0)
        rest = s[len("today"):].strip().lstrip("at").strip()
        return _apply_time_of_day(base, rest) or base

    # "monday at 3pm"
    for i, day in enumerate(_WEEKDAYS):
        if day in s:
            days_ahead = (i - now.weekday()) % 7 or 7
            base = (now + timedelta(days=days_ahead)).replace(hour=9, minute=0, second=0, microsecond=0)
            rest = re.sub(rf"(next\s+)?{day}", "", s).strip().lstrip("at").strip()
            return _apply_time_of_day(base, rest) or base

    # bare time: "3pm", "15:30"
    result = _apply_time_of_day(now.replace(second=0, microsecond=0), s)
    if result:
        if result <= now:
            result += timedelta(days=1)
        return result
    return None


async def add_reminder(
    redis: aioredis.Redis,
    user_id: str,
    text: str,
    fire_at: datetime,
    channel_type: str = "whatsapp",
    platform_id: str = "",
) -> str:
    rid = uuid.uuid4().hex[:8]
    entry = json.dumps({
        "id": rid,
        "text": text,
        "createdAt": datetime.now(SGT).isoformat(),
        "channelType": channel_type,
        "platformId": platform_id or f"{user_id}@s.whatsapp.net",
    })
    await redis.zadd(REMINDERS_PREFIX + user_id, {entry: fire_at.timestamp()})
    return rid


async def list_reminders(redis: aioredis.Redis, user_id: str) -> list[dict]:
    now_ts = time.time()
    items = await redis.zrangebyscore(REMINDERS_PREFIX + user_id, now_ts, "+inf", withscores=True)
    result = []
    for member, score in items:
        try:
            d = json.loads(member)
            d["fireAt"] = datetime.fromtimestamp(score, tz=SGT).strftime("%a %d %b, %-I:%M %p SGT")
            d["score"] = score
            result.append(d)
        except Exception:
            pass
    return result


async def cancel_reminder(redis: aioredis.Redis, user_id: str, rid: str) -> bool:
    key = REMINDERS_PREFIX + user_id
    for member in await redis.zrange(key, 0, -1):
        try:
            if json.loads(member).get("id", "").startswith(rid):
                await redis.zrem(key, member)
                return True
        except Exception:
            pass
    return False


async def parse_remind_command(redis: aioredis.Redis, user_id: str, text: str, channel_type: str = "whatsapp", platform_id: str = "") -> str:
    body = re.sub(r"^/remind\s+(me\s+to\s+|me\s+)?", "", text, flags=re.IGNORECASE).strip()

    split_at = re.split(r"\s+at\s+", body, maxsplit=1, flags=re.IGNORECASE)
    split_in = re.split(r"\s+in\s+(?=\d)", body, maxsplit=1, flags=re.IGNORECASE)

    if len(split_at) == 2:
        reminder_text, time_str = split_at[0].strip(), "at " + split_at[1].strip()
    elif len(split_in) == 2:
        reminder_text, time_str = split_in[0].strip(), "in " + split_in[1].strip()
    else:
        return (
            "\u26a0\ufe0f Couldn't understand the time. Try:\n"
            "\u2022 /remind me to call Bob *at 3pm*\n"
            "\u2022 /remind meeting prep *in 2 hours*\n"
            "\u2022 /remind check email *tomorrow at 9am*"
        )

    if not reminder_text:
        return "\u26a0\ufe0f What should I remind you about? e.g. /remind me to call Bob at 3pm"

    now = datetime.now(SGT)
    fire_at = _parse_time_str(time_str, now)
    if fire_at is None:
        return (
            f"\u26a0\ufe0f Couldn't parse \"{ time_str }\". Examples:\n"
            "at 3pm \u2022 at 15:30 \u2022 tomorrow at 9am \u2022 in 2 hours \u2022 in 30 minutes"
        )

    if fire_at <= now:
        return "\u26a0\ufe0f That time is in the past. Pick a future time."

    rid = await add_reminder(redis, user_id, reminder_text, fire_at, channel_type=channel_type, platform_id=platform_id)
    when_str = fire_at.strftime("%a, %d %b at %-I:%M %p SGT")
    return (
        f"\u23f0 Got it! I'll remind you to *{reminder_text}* on {when_str}.\n\n"
        f"ID: `{rid}` \u2014 use /remindclear {rid} to cancel"
    )


async def reminder_delivery_loop(redis: aioredis.Redis) -> None:
    """Background task: scan and fire due reminders every 30s."""
    logger.info("Reminder delivery loop started")
    while True:
        try:
            await asyncio.sleep(30)
            now_ts = time.time()
            cursor = b"0"
            while True:
                cursor, keys = await redis.scan(cursor, match=f"{REMINDERS_PREFIX}*", count=100)
                for key in keys:
                    user_id = key[len(REMINDERS_PREFIX):]
                    due = await redis.zrangebyscore(key, "-inf", now_ts, withscores=True)
                    for member, score in due:
                        try:
                            d = json.loads(member)
                            await _fire_reminder(
                                redis, user_id, d["text"],
                                channel_type=d.get("channelType", "whatsapp"),
                                platform_id=d.get("platformId", ""),
                            )
                            await redis.zrem(key, member)
                            logger.info("Reminder fired user=%s: %s", user_id, d["text"][:40])
                        except Exception as exc:
                            logger.error("Reminder fire failed user=%s: %s", user_id, exc)
                if cursor == b"0" or cursor == 0:
                    break
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Reminder loop error: %s", exc)


async def _fire_reminder(
    redis: aioredis.Redis,
    user_id: str,
    text: str,
    channel_type: str = "whatsapp",
    platform_id: str = "",
) -> None:
    _ch = channel_type or "whatsapp"
    if platform_id:
        _pid = platform_id
    elif _ch == "telegram":
        _pid = str(user_id)  # Telegram: chat_id is numeric user_id
    else:
        _pid = f"{user_id}@s.whatsapp.net"
    payload = json.dumps({
        "id": f"reminder-{uuid.uuid4().hex[:8]}",
        "userId": user_id,
        "type": "chat",
        "payload": {
            "content": f"\u23f0 *Reminder:* {text}",
            "platformId": _pid,
            "channelType": _ch,
            "threadId": None,
        },
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    await redis.lpush(RESPONSE_QUEUE, payload)
