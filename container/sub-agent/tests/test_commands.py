"""Tests for document management slash commands."""
import pytest
from unittest.mock import AsyncMock, MagicMock


@pytest.fixture
def mock_redis():
    r = AsyncMock()
    r.lpush = AsyncMock(return_value=1)
    r.blpop = AsyncMock(return_value=(b"key", b'{"success":true,"files":["doc1.pdf","doc2.txt"]}'))
    return r


@pytest.mark.asyncio
async def test_handle_command_returns_none_for_non_command(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "hello world")
    assert result is None


@pytest.mark.asyncio
async def test_handle_command_returns_help_for_help(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/help")
    assert result is not None
    assert "/list" in result
    assert "/delete" in result


@pytest.mark.asyncio
async def test_handle_command_returns_privacy_for_privacy(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/privacy")
    assert result is not None
    assert "PDPA" in result or "privacy" in result.lower() or "consent" in result.lower()


@pytest.mark.asyncio
async def test_handle_list_documents_formats_numbered_list(mock_redis):
    from src.commands import handle_list_documents
    result = await handle_list_documents(mock_redis, "u1")
    assert "doc1.pdf" in result
    assert "doc2.txt" in result
    assert "1." in result


@pytest.mark.asyncio
async def test_handle_list_documents_returns_no_documents_for_empty(mock_redis):
    from src.commands import handle_list_documents
    mock_redis.blpop = AsyncMock(return_value=(b"key", b'{"success":true,"files":[]}'))
    result = await handle_list_documents(mock_redis, "u1")
    assert "No documents found" in result


@pytest.mark.asyncio
async def test_handle_delete_document_sends_correct_payload(mock_redis):
    from src.commands import handle_delete_document
    mock_redis.blpop = AsyncMock(return_value=(b"key", b'{"success":true}'))
    result = await handle_delete_document(mock_redis, "u1", "report.pdf")
    assert "report.pdf" in result
    assert "deleted" in result.lower() or "✅" in result


@pytest.mark.asyncio
async def test_handle_delete_document_returns_error_on_timeout(mock_redis):
    from src.commands import handle_delete_document
    mock_redis.blpop = AsyncMock(return_value=None)
    result = await handle_delete_document(mock_redis, "u1", "report.pdf")
    assert "timeout" in result.lower() or "⚠️" in result


@pytest.mark.asyncio
async def test_delete_without_filename_returns_usage_hint(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/delete")
    assert result is not None
    assert "Usage" in result or "usage" in result or "/delete" in result


@pytest.mark.asyncio
async def test_unknown_command_returns_helpful_error(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/foobar")
    assert result is not None
    assert "Unknown" in result or "unknown" in result or "/help" in result


@pytest.mark.asyncio
async def test_privacy_command_returns_privacy_info(mock_redis):
    from src.commands import handle_command
    result = await handle_command(mock_redis, "u1", "/privacy")
    assert result is not None
    assert len(result) > 20
