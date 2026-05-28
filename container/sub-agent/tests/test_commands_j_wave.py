"""Tests for J1/J2/J3 new slash commands: /about /profile /ingested /forget-url."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import json


@pytest.fixture
def mock_redis():
    redis = MagicMock()
    redis.lpush = AsyncMock(return_value=1)
    redis.blpop = AsyncMock(return_value=None)
    redis.brpop = AsyncMock(return_value=None)
    return redis


# ── /about ──
@pytest.mark.asyncio
async def test_about_returns_about_text(mock_redis):
    from src.commands import handle_command, ABOUT_TEXT
    result = await handle_command(mock_redis, "u1", "/about")
    assert result == ABOUT_TEXT
    assert "personal life assistant" in result.lower()
    assert "/forget" in result


# ── /profile (read) ──
@pytest.mark.asyncio
async def test_profile_no_arg_for_new_user_returns_setup_help(mock_redis):
    """When user has no preferences, /profile shows the setup hint."""
    with patch("src.persona.preference_probe.probe_user_preferences", new=AsyncMock(
        return_value=type("Ctx", (), {
            "is_new_user": True, "technical_depth": None, "primary_domain": None
        })()
    )):
        from src.commands import handle_command
        result = await handle_command(mock_redis, "u1", "/profile")
    assert "No preferences saved yet" in result
    assert "depth=detailed" in result


@pytest.mark.asyncio
async def test_profile_no_arg_for_known_user_returns_current(mock_redis):
    with patch("src.persona.preference_probe.probe_user_preferences", new=AsyncMock(
        return_value=type("Ctx", (), {
            "is_new_user": False,
            "technical_depth": "detailed",
            "primary_domain": "infrastructure",
        })()
    )):
        from src.commands import handle_command
        result = await handle_command(mock_redis, "u1", "/profile")
    assert "Technical depth: detailed" in result
    assert "Primary domain: infrastructure" in result


# ── /profile (write) ──
@pytest.mark.asyncio
async def test_profile_set_depth_writes_to_dg(mock_redis):
    with patch("src.persona.preference_probe.probe_user_preferences", new=AsyncMock(
        return_value=type("Ctx", (), {
            "is_new_user": False, "technical_depth": "high-level", "primary_domain": "data"
        })()
    )):
        from src.commands import handle_command
        result = await handle_command(mock_redis, "u1", "/profile depth=detailed")
    assert "Updated: depth=detailed" in result
    # verify a put_user_preference was queued
    mock_redis.lpush.assert_called()
    queued = json.loads(mock_redis.lpush.call_args[0][1])
    assert queued["action"] == "put_user_preference"
    assert queued["preferences"]["technical_depth"] == "detailed"
    # primary_domain preserved
    assert queued["preferences"]["primary_domain"] == "data"


@pytest.mark.asyncio
async def test_profile_invalid_depth_rejected(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/profile depth=foobar")
    assert "must be one of" in result


@pytest.mark.asyncio
async def test_profile_invalid_key_rejected(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/profile color=blue")
    assert "Only `depth` and `domain`" in result


@pytest.mark.asyncio
async def test_profile_malformed_arg_returns_usage(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/profile bogus")
    assert "Usage" in result


# ── /ingested ──
@pytest.mark.asyncio
async def test_ingested_no_urls_returns_empty_message(mock_redis):
    mock_redis.blpop = AsyncMock(return_value=("k", json.dumps({"success": True, "urls": []})))
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/ingested")
    assert "No URLs ingested" in result


@pytest.mark.asyncio
async def test_ingested_with_urls_lists_them(mock_redis):
    mock_redis.blpop = AsyncMock(return_value=("k", json.dumps({
        "success": True,
        "urls": [
            {"url": "https://example.com/a", "title": "A page"},
            {"url": "https://example.com/b", "title": None},
        ]
    })))
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/ingested")
    assert "A page" in result
    assert "https://example.com/a" in result
    assert "https://example.com/b" in result


@pytest.mark.asyncio
async def test_ingested_unknown_action_falls_back_gracefully(mock_redis):
    mock_redis.blpop = AsyncMock(return_value=("k", json.dumps({
        "success": False, "error": "unknown action: list_ingested_urls"
    })))
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/ingested")
    assert "coming soon" in result.lower() or "isn\'t surfaced" in result.lower()


# ── /forget-url ──
@pytest.mark.asyncio
async def test_forget_url_no_arg_shows_usage(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/forget-url")
    assert "Usage" in result


@pytest.mark.asyncio
async def test_forget_url_success(mock_redis):
    mock_redis.blpop = AsyncMock(return_value=("k", json.dumps({"success": True})))
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/forget-url https://x.com/page")
    assert "Removed" in result
    assert "https://x.com/page" in result


@pytest.mark.asyncio
async def test_forget_url_unknown_action_falls_back(mock_redis):
    mock_redis.blpop = AsyncMock(return_value=("k", json.dumps({
        "success": False, "error": "unsupported action"
    })))
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/forget-url https://x.com/page")
    assert "coming soon" in result.lower() or "isn\'t wired" in result.lower()


# ── /help shows new commands ──
@pytest.mark.asyncio
async def test_help_includes_new_commands(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/help")
    assert "/profile" in result
    assert "/ingested" in result
    assert "/forget-url" in result
    assert "/about" in result
