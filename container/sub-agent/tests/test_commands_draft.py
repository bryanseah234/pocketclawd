"""F4 (Wave 9): tests for /draft slash command."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


@pytest.fixture
def mock_redis():
    redis = MagicMock()
    redis.lpush = AsyncMock(return_value=1)
    return redis


@pytest.mark.asyncio
async def test_draft_no_args_shows_usage(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/draft")
    assert "Usage" in result
    assert "minutes" in result and "slides" in result


@pytest.mark.asyncio
async def test_draft_unknown_type_rejected(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/draft pancakes some topic")
    assert "Unknown draft type" in result


@pytest.mark.asyncio
async def test_draft_minutes_invokes_bedrock(mock_redis):
    fake_resp = MagicMock()
    fake_resp.content = "Date: TBD\nAttendees: TBD\n- Bullet 1\n- Bullet 2"
    fake_client = MagicMock()
    fake_client.invoke = AsyncMock(return_value=fake_resp)

    with patch("src.llm.bedrock_client.BedrockClient", return_value=fake_client):
        from src.commands import handle_command
        result = await handle_command(mock_redis, "u1", "/draft minutes Q3 review")

    assert "Minutes draft" in result
    assert "Bullet 1" in result
    fake_client.invoke.assert_called_once()
    # System prompt was the minutes template
    call_args = fake_client.invoke.call_args
    assert "meeting minutes" in call_args.kwargs["system_prompt"].lower()


@pytest.mark.asyncio
async def test_draft_handles_bedrock_error(mock_redis):
    fake_client = MagicMock()
    fake_client.invoke = AsyncMock(side_effect=RuntimeError("Bedrock down"))

    with patch("src.llm.bedrock_client.BedrockClient", return_value=fake_client):
        from src.commands import handle_command
        result = await handle_command(mock_redis, "u1", "/draft slides Project X")

    assert "Could not generate" in result


@pytest.mark.asyncio
async def test_draft_empty_response_handled(mock_redis):
    fake_resp = MagicMock()
    fake_resp.content = "   "
    fake_client = MagicMock()
    fake_client.invoke = AsyncMock(return_value=fake_resp)

    with patch("src.llm.bedrock_client.BedrockClient", return_value=fake_client):
        from src.commands import handle_command
        result = await handle_command(mock_redis, "u1", "/draft email follow up")
    assert "empty draft" in result.lower()


@pytest.mark.asyncio
async def test_help_includes_draft(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/help")
    assert "/draft" in result
    assert "minutes" in result
