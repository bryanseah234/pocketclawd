"""Tests for PDPA consent module."""
import pytest
from unittest.mock import AsyncMock
from datetime import datetime, timezone, timedelta
import json


def make_redis_with_consent(status="granted", days_ago=30):
    r = AsyncMock()
    ts = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
    r.hgetall = AsyncMock(return_value={"status": status, "timestamp": ts, "version": "1.0", "user_id": "u1"})
    r.hget = AsyncMock(return_value=status)
    r.hset = AsyncMock(return_value=1)
    r.expire = AsyncMock(return_value=1)
    return r


@pytest.mark.asyncio
async def test_needs_consent_true_for_new_user():
    from src.consent import needs_consent
    r = AsyncMock()
    r.hgetall = AsyncMock(return_value={})
    assert await needs_consent(r, "u1") is True


@pytest.mark.asyncio
async def test_needs_consent_false_after_consent_granted():
    from src.consent import needs_consent
    r = make_redis_with_consent("granted", days_ago=10)
    assert await needs_consent(r, "u1") is False


@pytest.mark.asyncio
async def test_needs_consent_true_after_one_year():
    from src.consent import needs_consent
    r = make_redis_with_consent("granted", days_ago=366)
    assert await needs_consent(r, "u1") is True


@pytest.mark.asyncio
async def test_record_consent_stores_correct_fields():
    from src.consent import record_consent
    r = AsyncMock()
    r.hset = AsyncMock(return_value=1)
    r.expire = AsyncMock(return_value=1)
    await record_consent(r, "u1", granted=True)
    r.hset.assert_called_once()
    call_kwargs = r.hset.call_args
    mapping = call_kwargs[1].get("mapping") or call_kwargs[0][1]
    assert mapping.get("status") == "granted"
    assert "timestamp" in mapping
    assert mapping.get("version") == "1.0"


@pytest.mark.asyncio
async def test_withdraw_consent_marks_as_withdrawn():
    from src.consent import withdraw_consent, WITHDRAWAL_MESSAGE
    r = AsyncMock()
    r.hset = AsyncMock(return_value=1)
    r.expire = AsyncMock(return_value=1)
    msg = await withdraw_consent(r, "u1")
    assert msg == WITHDRAWAL_MESSAGE
    r.hset.assert_called_once()


@pytest.mark.asyncio
async def test_handle_consent_response_accepts_yes():
    from src.consent import handle_consent_response
    r = AsyncMock()
    r.hget = AsyncMock(return_value="pending")
    r.hset = AsyncMock(return_value=1)
    r.expire = AsyncMock(return_value=1)
    r.hgetall = AsyncMock(return_value={})
    granted, msg = await handle_consent_response(r, "u1", "yes")
    assert granted is True
    assert len(msg) > 0


@pytest.mark.asyncio
async def test_handle_consent_response_rejects_no():
    from src.consent import handle_consent_response
    r = AsyncMock()
    r.hget = AsyncMock(return_value="pending")
    r.hset = AsyncMock(return_value=1)
    r.expire = AsyncMock(return_value=1)
    r.hgetall = AsyncMock(return_value={})
    granted, msg = await handle_consent_response(r, "u1", "no")
    assert granted is False
    assert len(msg) > 0


@pytest.mark.asyncio
async def test_check_annual_renewal_returns_reminder_after_11_months():
    from src.consent import check_annual_renewal
    r = make_redis_with_consent("granted", days_ago=340)
    result = await check_annual_renewal(r, "u1")
    assert result is not None
    assert "renewal" in result.lower() or "consent" in result.lower()
