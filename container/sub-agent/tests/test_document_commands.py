"""
Unit tests for document management commands and webhook token manager.

Tests /list, /delete, /update commands, webhook token lifecycle,
and auto-save mode behavior.

Requirements: REQ-5.2
"""

import hashlib
import json
import secrets
import time
from typing import Any

import pytest

from src.documents.commands import (
    TOKEN_EXPIRY_SECONDS,
    CommandResult,
    CommandType,
    DocumentCommands,
    DocumentInfo,
    UserPreferences,
    WebhookToken,
    WebhookTokenManager,
    is_document_command,
    parse_command,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


class FakeRedis:
    """Minimal fake Redis client for testing command interactions."""

    def __init__(self):
        self.queues: dict[str, list[str]] = {}
        self.responses: dict[str, list[str]] = {}

    async def lpush(self, key: str, value: str) -> int:
        if key not in self.queues:
            self.queues[key] = []
        self.queues[key].append(value)
        return len(self.queues[key])

    async def brpop(self, key: str, timeout: int = 0) -> tuple[str, str] | None:
        if key in self.responses and self.responses[key]:
            return (key, self.responses[key].pop(0))
        return None

    def set_response(self, key: str, data: Any) -> None:
        """Pre-load a response for a given key."""
        if key not in self.responses:
            self.responses[key] = []
        self.responses[key].append(
            json.dumps(data) if not isinstance(data, str) else data
        )

    def get_last_request(self, queue_key: str = "queue:orchestrator:data_gateway") -> dict | None:
        """Get the last request sent to a queue."""
        if queue_key in self.queues and self.queues[queue_key]:
            return json.loads(self.queues[queue_key][-1])
        return None


@pytest.fixture
def fake_redis():
    return FakeRedis()


@pytest.fixture
def token_manager(fake_redis):
    return WebhookTokenManager(redis_client=fake_redis, user_id="test-user-123")


@pytest.fixture
def doc_commands(fake_redis):
    return DocumentCommands(redis_client=fake_redis, user_id="test-user-123")


# ---------------------------------------------------------------------------
# WebhookTokenManager Tests
# ---------------------------------------------------------------------------


class TestWebhookTokenManager:
    """Tests for the WebhookTokenManager class."""

    def test_generate_token_returns_strings(self):
        raw_token, token_hash = WebhookTokenManager.generate_token()

        assert isinstance(raw_token, str)
        assert isinstance(token_hash, str)
        assert len(raw_token) > 0
        assert len(token_hash) == 64  # SHA-256 = 64 hex chars

    def test_generate_token_hash_matches_sha256(self):
        raw_token, token_hash = WebhookTokenManager.generate_token()

        # Verify the hash is correct SHA-256 of the raw token
        expected_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        assert token_hash == expected_hash

    def test_generate_token_produces_unique_tokens(self):
        tokens = set()
        for _ in range(100):
            raw_token, _ = WebhookTokenManager.generate_token()
            tokens.add(raw_token)
        # All tokens should be unique (cryptographically random)
        assert len(tokens) == 100

    def test_hash_token_matches_generate(self):
        raw_token, expected_hash = WebhookTokenManager.generate_token()
        computed_hash = WebhookTokenManager.hash_token(raw_token)
        assert computed_hash == expected_hash

    def test_hash_token_deterministic(self):
        raw_token, _ = WebhookTokenManager.generate_token()
        hash1 = WebhookTokenManager.hash_token(raw_token)
        hash2 = WebhookTokenManager.hash_token(raw_token)
        assert hash1 == hash2

    def test_hash_token_different_inputs_different_hashes(self):
        token1, _ = WebhookTokenManager.generate_token()
        token2, _ = WebhookTokenManager.generate_token()
        assert WebhookTokenManager.hash_token(token1) != WebhookTokenManager.hash_token(token2)

    @pytest.mark.asyncio
    async def test_create_save_token_returns_webhook_token(self, token_manager, fake_redis):
        token = await token_manager.create_save_token()

        assert isinstance(token, WebhookToken)
        assert token.user_id == "test-user-123"
        assert token.expires_at == token.created_at + TOKEN_EXPIRY_SECONDS
        assert len(token.raw_token) > 0
        assert len(token.token_hash) == 64

    @pytest.mark.asyncio
    async def test_create_save_token_sends_request_to_orchestrator(self, token_manager, fake_redis):
        token = await token_manager.create_save_token()

        # Verify a request was sent to the orchestrator queue
        assert "queue:orchestrator:data_gateway" in fake_redis.queues
        request = json.loads(fake_redis.queues["queue:orchestrator:data_gateway"][0])
        assert request["action"] == "create_webhook_token"
        assert request["user_id"] == "test-user-123"
        assert request["token_hash"] == token.token_hash

    @pytest.mark.asyncio
    async def test_create_save_token_expiry_is_15_minutes(self, token_manager):
        before = time.time()
        token = await token_manager.create_save_token()
        after = time.time()

        assert token.expires_at >= before + TOKEN_EXPIRY_SECONDS
        assert token.expires_at <= after + TOKEN_EXPIRY_SECONDS

    @pytest.mark.asyncio
    async def test_validate_token_success(self, token_manager, fake_redis):
        raw_token, token_hash = WebhookTokenManager.generate_token()

        # Pre-load a successful validation response
        # The response key uses a request_id, so we need to match it dynamically
        # Instead, we'll set up the response before calling validate
        # The validate method generates its own request_id, so we need to intercept

        # Override brpop to return success for any key matching the pattern
        original_brpop = fake_redis.brpop

        async def mock_brpop(key: str, timeout: int = 0):
            if "token_response" in key:
                return (key, json.dumps({"valid": True}))
            return await original_brpop(key, timeout)

        fake_redis.brpop = mock_brpop

        result = await token_manager.validate_token(raw_token)
        assert result is True

    @pytest.mark.asyncio
    async def test_validate_token_failure(self, token_manager, fake_redis):
        raw_token, _ = WebhookTokenManager.generate_token()

        async def mock_brpop(key: str, timeout: int = 0):
            if "token_response" in key:
                return (key, json.dumps({"valid": False}))
            return None

        fake_redis.brpop = mock_brpop

        result = await token_manager.validate_token(raw_token)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_token_timeout(self, token_manager, fake_redis):
        raw_token, _ = WebhookTokenManager.generate_token()

        # No response pre-loaded — will timeout (brpop returns None)
        result = await token_manager.validate_token(raw_token)
        assert result is False


# ---------------------------------------------------------------------------
# WebhookToken dataclass Tests
# ---------------------------------------------------------------------------


class TestWebhookTokenDataclass:
    """Tests for the WebhookToken dataclass."""

    def test_webhook_token_creation(self):
        token = WebhookToken(
            raw_token="test-token-value",
            token_hash="a" * 64,
            user_id="user-1",
            created_at=1000.0,
            expires_at=1900.0,
        )

        assert token.raw_token == "test-token-value"
        assert token.token_hash == "a" * 64
        assert token.user_id == "user-1"
        assert token.expires_at - token.created_at == 900.0

    def test_webhook_token_is_expired_false(self):
        token = WebhookToken(
            raw_token="t",
            token_hash="h",
            user_id="u",
            created_at=time.time(),
            expires_at=time.time() + 900,
        )
        assert token.is_expired is False

    def test_webhook_token_is_expired_true(self):
        token = WebhookToken(
            raw_token="t",
            token_hash="h",
            user_id="u",
            created_at=time.time() - 1000,
            expires_at=time.time() - 100,
        )
        assert token.is_expired is True


# ---------------------------------------------------------------------------
# DocumentCommands Tests — /list
# ---------------------------------------------------------------------------


class TestDocumentCommandsList:
    """Tests for the /list command."""

    @pytest.mark.asyncio
    async def test_list_returns_documents(self, doc_commands, fake_redis):
        # The list command generates a request_id, so we need to intercept brpop
        async def mock_brpop(key: str, timeout: int = 0):
            if "dg_response" in key:
                return (
                    key,
                    json.dumps({
                        "files": [
                            {"key": "documents/test-user-123/report.pdf", "size": 10240},
                            {"key": "documents/test-user-123/data.csv", "size": 2048},
                        ]
                    }),
                )
            return None

        fake_redis.brpop = mock_brpop

        result = await doc_commands.execute("/list")

        assert result.success is True
        assert "report.pdf" in result.message
        assert "data.csv" in result.message
        assert result.data["count"] == 2

    @pytest.mark.asyncio
    async def test_list_empty_documents(self, doc_commands, fake_redis):
        async def mock_brpop(key: str, timeout: int = 0):
            if "dg_response" in key:
                return (key, json.dumps({"files": []}))
            return None

        fake_redis.brpop = mock_brpop

        result = await doc_commands.execute("/list")

        assert result.success is True
        assert "no indexed documents" in result.message.lower()

    @pytest.mark.asyncio
    async def test_list_timeout(self, doc_commands, fake_redis):
        # No response — will timeout
        result = await doc_commands.execute("/list")

        assert result.success is False
        assert "timed out" in result.message.lower()

    @pytest.mark.asyncio
    async def test_list_sends_correct_request(self, doc_commands, fake_redis):
        # Just let it timeout, but check the request was sent correctly
        await doc_commands.execute("/list")

        request = fake_redis.get_last_request()
        assert request is not None
        assert request["action"] == "list_files"
        assert request["user_id"] == "test-user-123"
        assert "documents/test-user-123/" in request["prefix"]


# ---------------------------------------------------------------------------
# DocumentCommands Tests — /delete
# ---------------------------------------------------------------------------


class TestDocumentCommandsDelete:
    """Tests for the /delete command."""

    @pytest.mark.asyncio
    async def test_delete_requires_filename(self, doc_commands):
        result = await doc_commands.execute("/delete")

        assert result.success is False
        assert "Usage" in result.message

    @pytest.mark.asyncio
    async def test_delete_prompts_confirmation_when_no_auto_save(self, doc_commands, fake_redis):
        # Mock: preferences say auto_save = False
        async def mock_brpop(key: str, timeout: int = 0):
            if "dg_response" in key:
                return (key, json.dumps({"preferences": {"autoSave": False}}))
            return None

        fake_redis.brpop = mock_brpop

        result = await doc_commands.execute("/delete", ["report.pdf"])

        assert result.success is True
        assert "confirmation code" in result.message.lower()
        assert "report.pdf" in result.message
        assert result.data["pending_action"] == "delete"
        assert result.data["filename"] == "report.pdf"
        assert "token_hash" in result.data
        assert result.data["requires_confirmation"] is True

    @pytest.mark.asyncio
    async def test_delete_auto_save_skips_confirmation(self, doc_commands, fake_redis):
        call_count = [0]

        async def mock_brpop(key: str, timeout: int = 0):
            call_count[0] += 1
            if call_count[0] == 1:
                # First call: preferences
                return (key, json.dumps({"preferences": {"autoSave": True}}))
            elif call_count[0] == 2:
                # Second call: delete response
                return (key, json.dumps({"success": True}))
            return None

        fake_redis.brpop = mock_brpop

        result = await doc_commands.execute("/delete", ["report.pdf"])

        assert result.success is True
        assert "deleted" in result.message.lower()

    @pytest.mark.asyncio
    async def test_delete_auto_save_timeout(self, doc_commands, fake_redis):
        call_count = [0]

        async def mock_brpop(key: str, timeout: int = 0):
            call_count[0] += 1
            if call_count[0] == 1:
                # Preferences: auto_save enabled
                return (key, json.dumps({"preferences": {"autoSave": True}}))
            # Delete response: timeout
            return None

        fake_redis.brpop = mock_brpop

        result = await doc_commands.execute("/delete", ["report.pdf"])

        assert result.success is False
        assert "timed out" in result.message.lower()


# ---------------------------------------------------------------------------
# DocumentCommands Tests — /update
# ---------------------------------------------------------------------------


class TestDocumentCommandsUpdate:
    """Tests for the /update command."""

    @pytest.mark.asyncio
    async def test_update_requires_filename(self, doc_commands):
        result = await doc_commands.execute("/update")

        assert result.success is False
        assert "Usage" in result.message

    @pytest.mark.asyncio
    async def test_update_retrieves_file_for_reprocessing(self, doc_commands, fake_redis):
        call_count = [0]

        async def mock_brpop(key: str, timeout: int = 0):
            call_count[0] += 1
            if "dg_response" in key and "_get" in key:
                # File retrieval response
                return (
                    key,
                    json.dumps({
                        "success": True,
                        "content": "file content here",
                        "content_type": "text/plain",
                    }),
                )
            return None

        fake_redis.brpop = mock_brpop

        result = await doc_commands.update_document("data.csv")

        assert result.success is True
        assert "re-processing" in result.message.lower()
        assert result.data["filename"] == "data.csv"

    @pytest.mark.asyncio
    async def test_update_file_not_found(self, doc_commands, fake_redis):
        async def mock_brpop(key: str, timeout: int = 0):
            if "dg_response" in key and "_get" in key:
                return (key, json.dumps({"success": False}))
            return None

        fake_redis.brpop = mock_brpop

        result = await doc_commands.update_document("nonexistent.pdf")

        assert result.success is False
        assert "not found" in result.message.lower()


# ---------------------------------------------------------------------------
# DocumentCommands Tests — confirm_delete
# ---------------------------------------------------------------------------


class TestDocumentCommandsConfirmDelete:
    """Tests for the confirm_delete flow."""

    @pytest.mark.asyncio
    async def test_confirm_delete_valid_token(self, doc_commands, fake_redis):
        call_count = [0]

        async def mock_brpop(key: str, timeout: int = 0):
            call_count[0] += 1
            if "token_response" in key:
                return (key, json.dumps({"valid": True}))
            if "dg_response" in key:
                return (key, json.dumps({"success": True}))
            return None

        fake_redis.brpop = mock_brpop

        raw_token, _ = WebhookTokenManager.generate_token()
        result = await doc_commands.confirm_delete("report.pdf", raw_token)

        assert result.success is True
        assert "deleted" in result.message.lower()

    @pytest.mark.asyncio
    async def test_confirm_delete_invalid_token(self, doc_commands, fake_redis):
        async def mock_brpop(key: str, timeout: int = 0):
            if "token_response" in key:
                return (key, json.dumps({"valid": False}))
            return None

        fake_redis.brpop = mock_brpop

        raw_token, _ = WebhookTokenManager.generate_token()
        result = await doc_commands.confirm_delete("report.pdf", raw_token)

        assert result.success is False
        assert "invalid" in result.message.lower() or "expired" in result.message.lower()


# ---------------------------------------------------------------------------
# DocumentCommands Tests — save confirmation
# ---------------------------------------------------------------------------


class TestDocumentCommandsSaveConfirmation:
    """Tests for the handle_save_confirmation flow."""

    @pytest.mark.asyncio
    async def test_save_auto_mode_proceeds_directly(self, doc_commands, fake_redis):
        async def mock_brpop(key: str, timeout: int = 0):
            if "dg_response" in key:
                return (key, json.dumps({"preferences": {"autoSave": True}}))
            return None

        fake_redis.brpop = mock_brpop

        result = await doc_commands.handle_save_confirmation(
            "doc.pdf", b"content", "application/pdf"
        )

        assert result.success is True
        assert "auto-saving" in result.message.lower()
        assert result.data["auto_saved"] is True

    @pytest.mark.asyncio
    async def test_save_manual_mode_prompts_confirmation(self, doc_commands, fake_redis):
        async def mock_brpop(key: str, timeout: int = 0):
            if "dg_response" in key:
                return (key, json.dumps({"preferences": {"autoSave": False}}))
            return None

        fake_redis.brpop = mock_brpop

        result = await doc_commands.handle_save_confirmation(
            "doc.pdf", b"content", "application/pdf"
        )

        assert result.success is True
        assert "confirmation code" in result.message.lower()
        assert result.data["requires_confirmation"] is True
        assert result.data["pending_action"] == "save"

    @pytest.mark.asyncio
    async def test_confirm_save_valid_token(self, doc_commands, fake_redis):
        async def mock_brpop(key: str, timeout: int = 0):
            if "token_response" in key:
                return (key, json.dumps({"valid": True}))
            return None

        fake_redis.brpop = mock_brpop

        raw_token, _ = WebhookTokenManager.generate_token()
        result = await doc_commands.confirm_save(
            raw_token, "doc.pdf", b"content", "application/pdf"
        )

        assert result.success is True
        assert "confirmed" in result.message.lower()

    @pytest.mark.asyncio
    async def test_confirm_save_invalid_token(self, doc_commands, fake_redis):
        async def mock_brpop(key: str, timeout: int = 0):
            if "token_response" in key:
                return (key, json.dumps({"valid": False}))
            return None

        fake_redis.brpop = mock_brpop

        raw_token, _ = WebhookTokenManager.generate_token()
        result = await doc_commands.confirm_save(
            raw_token, "doc.pdf", b"content", "application/pdf"
        )

        assert result.success is False
        assert "invalid" in result.message.lower() or "expired" in result.message.lower()


# ---------------------------------------------------------------------------
# DocumentCommands Tests — unknown command
# ---------------------------------------------------------------------------


class TestDocumentCommandsUnknown:
    """Tests for unknown commands."""

    @pytest.mark.asyncio
    async def test_unknown_command(self, doc_commands):
        result = await doc_commands.execute("/unknown")
        assert result.success is False
        assert "Unknown command" in result.message


# ---------------------------------------------------------------------------
# UserPreferences model Tests
# ---------------------------------------------------------------------------


class TestUserPreferences:
    """Tests for the UserPreferences pydantic model."""

    def test_defaults(self):
        prefs = UserPreferences()
        assert prefs.auto_save is False
        assert prefs.notification_time == "09:00"
        assert prefs.slide_template == "Corporate"
        assert prefs.consent_given is False

    def test_custom_values(self):
        prefs = UserPreferences(
            auto_save=True,
            notification_time="08:00",
            slide_template="Modern",
            consent_given=True,
        )
        assert prefs.auto_save is True
        assert prefs.notification_time == "08:00"
        assert prefs.slide_template == "Modern"
        assert prefs.consent_given is True


# ---------------------------------------------------------------------------
# DocumentInfo model Tests
# ---------------------------------------------------------------------------


class TestDocumentInfoModel:
    """Tests for the DocumentInfo pydantic model."""

    def test_document_info_creation(self):
        doc = DocumentInfo(
            filename="report.pdf",
            uploaded_at="2024-01-15T10:00:00Z",
            chunk_count=5,
            doc_type="application/pdf",
            size_bytes=10240,
        )

        assert doc.filename == "report.pdf"
        assert doc.chunk_count == 5
        assert doc.doc_type == "application/pdf"
        assert doc.size_bytes == 10240

    def test_document_info_defaults(self):
        doc = DocumentInfo(filename="test.txt")
        assert doc.uploaded_at == ""
        assert doc.chunk_count == 0
        assert doc.doc_type == "unknown"
        assert doc.size_bytes == 0


# ---------------------------------------------------------------------------
# Utility Tests
# ---------------------------------------------------------------------------


class TestIsDocumentCommand:
    """Tests for the is_document_command utility."""

    def test_recognizes_list_command(self):
        assert is_document_command("/list") is True
        assert is_document_command("/list ") is True
        assert is_document_command("  /list") is True

    def test_recognizes_delete_command(self):
        assert is_document_command("/delete report.pdf") is True
        assert is_document_command("/delete") is True

    def test_recognizes_update_command(self):
        assert is_document_command("/update data.csv") is True
        assert is_document_command("/update") is True

    def test_rejects_non_commands(self):
        assert is_document_command("hello") is False
        assert is_document_command("list") is False
        assert is_document_command("/unknown") is False
        assert is_document_command("") is False

    def test_case_insensitive(self):
        assert is_document_command("/LIST") is True
        assert is_document_command("/Delete file.pdf") is True
        assert is_document_command("/UPDATE") is True


class TestParseCommand:
    """Tests for the parse_command utility."""

    def test_parse_list(self):
        cmd, args = parse_command("/list")
        assert cmd == "/list"
        assert args == []

    def test_parse_delete_with_filename(self):
        cmd, args = parse_command("/delete report.pdf")
        assert cmd == "/delete"
        assert args == ["report.pdf"]

    def test_parse_update_with_filename(self):
        cmd, args = parse_command("/update data.csv")
        assert cmd == "/update"
        assert args == ["data.csv"]

    def test_parse_non_command(self):
        cmd, args = parse_command("hello world")
        assert cmd is None
        assert args == []

    def test_parse_with_leading_whitespace(self):
        cmd, args = parse_command("  /list")
        assert cmd == "/list"
        assert args == []

    def test_parse_case_normalization(self):
        cmd, args = parse_command("/DELETE file.txt")
        assert cmd == "/delete"
        assert args == ["file.txt"]
