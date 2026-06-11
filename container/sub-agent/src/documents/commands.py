"""
Document management commands — /list, /delete, /update.

Implements webhook-based save confirmation with SHA-256 hashed one-time tokens
(15-min expiry) and auto-save mode (configurable per user via DynamoDB preferences).

The sub-agent communicates with the orchestrator's Data Gateway via Redis queues
for all persistence operations (DynamoDB, OpenSearch, S3).

Requirements: REQ-5.2
"""

import hashlib
import json
import logging
import secrets
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import redis.asyncio as aioredis
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Token expiry: 15 minutes in seconds
TOKEN_EXPIRY_SECONDS = 900


class CommandType(str, Enum):
    """Supported document management commands."""

    LIST = "/list"
    DELETE = "/delete"
    UPDATE = "/update"


class DocumentInfo(BaseModel):
    """Information about an indexed document."""

    filename: str
    uploaded_at: str = ""
    chunk_count: int = 0
    doc_type: str = "unknown"
    size_bytes: int = 0


class UserPreferences(BaseModel):
    """User preferences fetched from DynamoDB via the orchestrator."""

    auto_save: bool = False
    notification_time: str = "09:00"
    slide_template: str = "Corporate"
    consent_given: bool = False


@dataclass
class CommandResult:
    """Result of executing a document command."""

    success: bool
    message: str
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class WebhookToken:
    """A webhook confirmation token with its hash and metadata."""

    raw_token: str
    token_hash: str
    user_id: str
    created_at: float  # Unix timestamp
    expires_at: float  # Unix timestamp

    @property
    def is_expired(self) -> bool:
        """Check if the token has expired."""
        return time.time() > self.expires_at


class WebhookTokenManager:
    """
    Manages webhook-based save confirmation tokens.

    Token lifecycle:
    1. Generate a cryptographically random token
    2. Compute SHA-256 hash of the token
    3. Send the hash to the orchestrator for storage in DynamoDB (15-min TTL)
    4. Return the raw token to the user for confirmation
    5. On confirmation, hash the user-provided token and validate via orchestrator

    Tokens are one-time use — once validated, they cannot be reused.
    """

    def __init__(self, redis_client: aioredis.Redis, user_id: str) -> None:
        self._redis = redis_client
        self._user_id = user_id

    @staticmethod
    def generate_token() -> tuple[str, str]:
        """
        Generate a new random token and its SHA-256 hash.

        Returns:
            Tuple of (raw_token, token_hash).
        """
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        return raw_token, token_hash

    @staticmethod
    def hash_token(raw_token: str) -> str:
        """
        Compute the SHA-256 hash of a raw token.

        Args:
            raw_token: The plaintext token string.

        Returns:
            Hex-encoded SHA-256 hash.
        """
        return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

    async def create_save_token(self) -> WebhookToken:
        """
        Create a new save confirmation token and register it with the orchestrator.

        The token hash is sent to the orchestrator via Redis for storage in
        DynamoDB with a 15-minute TTL.

        Returns:
            WebhookToken containing the raw token (to send to user) and metadata.
        """
        raw_token, token_hash = self.generate_token()
        now = time.time()
        expires_at = now + TOKEN_EXPIRY_SECONDS

        # Send token creation request to orchestrator via Redis
        request = {
            "action": "create_webhook_token",
            "user_id": self._user_id,
            "token_hash": token_hash,
            "created_at": now,
            "expires_at": expires_at,
        }
        await self._redis.lpush(
            "queue:orchestrator:data_gateway",
            json.dumps(request),
        )

        logger.info(
            "Created save confirmation token for user_id=%s (expires in %ds)",
            self._user_id,
            TOKEN_EXPIRY_SECONDS,
        )

        return WebhookToken(
            raw_token=raw_token,
            token_hash=token_hash,
            user_id=self._user_id,
            created_at=now,
            expires_at=expires_at,
        )

    async def validate_token(self, raw_token: str) -> bool:
        """
        Validate a user-provided confirmation token.

        Hashes the provided token and sends a validation request to the
        orchestrator. The orchestrator checks DynamoDB for the token hash,
        verifies it hasn't expired or been used, and marks it as consumed.

        Args:
            raw_token: The plaintext token provided by the user.

        Returns:
            True if the token is valid (exists, not expired, not previously used).
        """
        token_hash = self.hash_token(raw_token)

        # Send validation request to orchestrator
        request_id = secrets.token_hex(8)
        request = {
            "action": "validate_webhook_token",
            "request_id": request_id,
            "token_hash": token_hash,
        }
        await self._redis.lpush(
            "queue:orchestrator:data_gateway",
            json.dumps(request),
        )

        # Wait for validation response (with timeout)
        response_key = f"queue:agent:{self._user_id}:token_response:{request_id}"
        result = await self._redis.brpop(response_key, timeout=10)

        if result is None:
            logger.warning(
                "Token validation timed out for user_id=%s", self._user_id
            )
            return False

        _key, raw_response = result
        response = json.loads(raw_response)
        return response.get("valid", False)


class DocumentCommands:
    """
    Handles document management commands: /list, /delete, /update.

    Communicates with the orchestrator's Data Gateway via Redis for all
    persistence operations. Supports auto-save mode (skips confirmation)
    and webhook-based save confirmation for manual mode.
    """

    def __init__(
        self,
        redis_client: aioredis.Redis,
        user_id: str,
        token_manager: WebhookTokenManager | None = None,
    ) -> None:
        self._redis = redis_client
        self._user_id = user_id
        self._token_manager = token_manager or WebhookTokenManager(
            redis_client, user_id
        )

    async def execute(self, command: str, args: list[str] | None = None) -> CommandResult:
        """
        Route and execute a document command.

        Args:
            command: The command string (e.g., "/list", "/delete", "/update").
            args: Optional arguments for the command.

        Returns:
            CommandResult with success status and response message.
        """
        args = args or []
        cmd = command.strip().lower()

        if cmd == CommandType.LIST:
            return await self.list_documents()
        elif cmd == CommandType.DELETE:
            if not args:
                return CommandResult(
                    success=False,
                    message="Usage: /delete [filename] — please specify the file to delete.",
                )
            return await self.delete_document(args[0])
        elif cmd == CommandType.UPDATE:
            if not args:
                return CommandResult(
                    success=False,
                    message="Usage: /update [filename] — please specify the file to re-process.",
                )
            return await self.update_document(args[0])
        else:
            return CommandResult(
                success=False,
                message=f"Unknown command: {command}. Available commands: /list, /delete, /update",
            )

    async def list_documents(self) -> CommandResult:
        """
        List all indexed documents for the current user.

        Sends a request to the orchestrator's Data Gateway to list files
        from S3 under the user's documents prefix.

        Returns:
            CommandResult with the list of documents.
        """
        request_id = secrets.token_hex(8)
        request = {
            "action": "list_files",
            "request_id": request_id,
            "user_id": self._user_id,
            "prefix": f"documents/{self._user_id}/",
        }
        await self._redis.lpush(
            "queue:orchestrator:data_gateway",
            json.dumps(request),
        )

        # Wait for response
        response_key = f"queue:agent:{self._user_id}:dg_response:{request_id}"
        result = await self._redis.brpop(response_key, timeout=15)

        if result is None:
            logger.warning("List documents timed out for user_id=%s", self._user_id)
            return CommandResult(
                success=False,
                message="Request timed out. Please try again.",
            )

        _key, raw_response = result
        response = json.loads(raw_response)
        files = response.get("files", [])

        if not files:
            return CommandResult(
                success=True,
                message="You have no indexed documents.",
                data={"files": []},
            )

        # Format file list for display
        file_lines = []
        for f in files:
            name = f.get("key", "").split("/")[-1]
            size_kb = f.get("size", 0) / 1024
            file_lines.append(f"• {name} ({size_kb:.1f} KB)")

        message = f"📄 Your indexed documents ({len(files)}):\n" + "\n".join(file_lines)

        return CommandResult(
            success=True,
            message=message,
            data={"files": files, "count": len(files)},
        )

    async def delete_document(self, filename: str) -> CommandResult:
        """
        Delete a specific document and its indexed chunks.

        Requires save confirmation unless auto-save mode is enabled.

        Args:
            filename: Name of the file to delete.

        Returns:
            CommandResult with deletion status.
        """
        # Check auto-save mode
        auto_save = await self._get_auto_save_preference()

        if not auto_save:
            # Generate confirmation token
            token = await self._token_manager.create_save_token()
            return CommandResult(
                success=True,
                message=(
                    f"⚠️ Are you sure you want to delete '{filename}'?\n"
                    f"Reply with this confirmation code to proceed:\n"
                    f"`{token.raw_token}`\n\n"
                    f"This code expires in 15 minutes."
                ),
                data={
                    "pending_action": "delete",
                    "filename": filename,
                    "token_hash": token.token_hash,
                    "requires_confirmation": True,
                },
            )

        # Auto-save mode: proceed directly
        return await self._execute_delete(filename)

    async def confirm_delete(self, filename: str, raw_token: str) -> CommandResult:
        """
        Confirm and execute a document deletion after token validation.

        Args:
            filename: Name of the file to delete.
            raw_token: The confirmation token provided by the user.

        Returns:
            CommandResult with deletion status.
        """
        is_valid = await self._token_manager.validate_token(raw_token)

        if not is_valid:
            return CommandResult(
                success=False,
                message=(
                    "❌ Invalid or expired confirmation code. "
                    "Please use /delete again to get a new code."
                ),
            )

        return await self._execute_delete(filename)

    async def _execute_delete(self, filename: str) -> CommandResult:
        """
        Execute the actual document deletion via the Data Gateway.

        Deletes both the S3 file and the OpenSearch indexed chunks.
        """
        request_id = secrets.token_hex(8)

        # Delete from OpenSearch (indexed chunks)
        delete_index_request = {
            "action": "delete_user_documents",
            "request_id": request_id,
            "user_id": self._user_id,
            "filename": filename,
        }
        await self._redis.lpush(
            "queue:orchestrator:data_gateway",
            json.dumps(delete_index_request),
        )

        # Delete from S3
        delete_file_request = {
            "action": "delete_file",
            "request_id": f"{request_id}_s3",
            "user_id": self._user_id,
            "bucket": "documents",
            "key": f"documents/{self._user_id}/{filename}",
        }
        await self._redis.lpush(
            "queue:orchestrator:data_gateway",
            json.dumps(delete_file_request),
        )

        # Wait for confirmation from Data Gateway
        response_key = f"queue:agent:{self._user_id}:dg_response:{request_id}"
        result = await self._redis.brpop(response_key, timeout=15)

        if result is None:
            logger.warning(
                "Delete document timed out for user_id=%s filename=%s",
                self._user_id,
                filename,
            )
            return CommandResult(
                success=False,
                message=f"Delete request for '{filename}' timed out. Please try again.",
            )

        logger.info(
            "Deleted document '%s' for user_id=%s", filename, self._user_id
        )

        return CommandResult(
            success=True,
            message=f"✅ Document '{filename}' has been deleted and removed from the index.",
            data={"filename": filename, "deleted": True},
        )

    async def update_document(self, filename: str) -> CommandResult:
        """
        Re-process and re-index a document.

        Triggers the document processing pipeline to re-extract, re-chunk,
        and re-embed the specified document.

        Args:
            filename: Name of the file to re-process.

        Returns:
            CommandResult with update status.
        """
        # First, delete existing index entries for this document
        request_id = secrets.token_hex(8)
        delete_request = {
            "action": "delete_user_documents",
            "request_id": request_id,
            "user_id": self._user_id,
            "filename": filename,
        }
        await self._redis.lpush(
            "queue:orchestrator:data_gateway",
            json.dumps(delete_request),
        )

        # Request the file content from S3 for re-processing
        get_file_request = {
            "action": "get_file",
            "request_id": f"{request_id}_get",
            "user_id": self._user_id,
            "bucket": "documents",
            "key": f"documents/{self._user_id}/{filename}",
        }
        await self._redis.lpush(
            "queue:orchestrator:data_gateway",
            json.dumps(get_file_request),
        )

        # Wait for file content response
        response_key = f"queue:agent:{self._user_id}:dg_response:{request_id}_get"
        result = await self._redis.brpop(response_key, timeout=30)

        if result is None:
            return CommandResult(
                success=False,
                message=f"Could not retrieve '{filename}' for re-processing. Please try again.",
            )

        _key, raw_response = result
        response = json.loads(raw_response)

        if not response.get("success", False):
            return CommandResult(
                success=False,
                message=f"File '{filename}' not found. Use /list to see available documents.",
            )

        logger.info(
            "Re-processing document '%s' for user_id=%s", filename, self._user_id
        )

        return CommandResult(
            success=True,
            message=(
                f"🔄 Re-processing '{filename}'...\n"
                f"The document will be re-extracted, re-chunked, and re-indexed. "
                f"This may take a moment."
            ),
            data={
                "filename": filename,
                "action": "update",
                "content": response.get("content"),
                "content_type": response.get("content_type", "application/octet-stream"),
            },
        )

    async def _get_auto_save_preference(self) -> bool:
        """
        Check if the user has auto-save mode enabled.

        Queries the orchestrator's Data Gateway for user preferences stored
        in DynamoDB.

        Returns:
            True if auto-save is enabled, False otherwise.
        """
        request_id = secrets.token_hex(8)
        request = {
            "action": "get_user_preference",
            "request_id": request_id,
            "user_id": self._user_id,
        }
        await self._redis.lpush(
            "queue:orchestrator:data_gateway",
            json.dumps(request),
        )

        # Wait for response
        response_key = f"queue:agent:{self._user_id}:dg_response:{request_id}"
        result = await self._redis.brpop(response_key, timeout=10)

        if result is None:
            # Default to requiring confirmation if preferences can't be fetched
            logger.warning(
                "Failed to fetch user preferences for user_id=%s, defaulting to manual confirmation",
                self._user_id,
            )
            return False

        _key, raw_response = result
        response = json.loads(raw_response)
        preferences = response.get("preferences")

        if preferences is None:
            return False

        return preferences.get("autoSave", False)

    async def handle_save_confirmation(
        self, filename: str, content: bytes, content_type: str
    ) -> CommandResult:
        """
        Handle document save with confirmation flow.

        If auto-save is enabled, saves immediately. Otherwise, generates a
        confirmation token and asks the user to confirm.

        Args:
            filename: Name of the file to save.
            content: Raw file bytes.
            content_type: MIME type of the file.

        Returns:
            CommandResult — either confirmation prompt or save success.
        """
        auto_save = await self._get_auto_save_preference()

        if auto_save:
            # Auto-save: proceed directly
            return CommandResult(
                success=True,
                message=f"📥 Auto-saving '{filename}'... Processing will begin shortly.",
                data={
                    "action": "save",
                    "filename": filename,
                    "auto_saved": True,
                },
            )

        # Manual mode: generate confirmation token
        token = await self._token_manager.create_save_token()

        return CommandResult(
            success=True,
            message=(
                f"📄 Ready to save and process '{filename}'.\n"
                f"Reply with this confirmation code to proceed:\n"
                f"`{token.raw_token}`\n\n"
                f"This code expires in 15 minutes."
            ),
            data={
                "pending_action": "save",
                "filename": filename,
                "token_hash": token.token_hash,
                "requires_confirmation": True,
            },
        )

    async def confirm_save(
        self, raw_token: str, filename: str, content: bytes, content_type: str
    ) -> CommandResult:
        """
        Confirm and execute a document save after token validation.

        Args:
            raw_token: The confirmation token provided by the user.
            filename: Name of the file to save.
            content: Raw file bytes.
            content_type: MIME type of the file.

        Returns:
            CommandResult with save status.
        """
        is_valid = await self._token_manager.validate_token(raw_token)

        if not is_valid:
            return CommandResult(
                success=False,
                message=(
                    "❌ Invalid or expired confirmation code. "
                    "Please upload the file again to get a new code."
                ),
            )

        return CommandResult(
            success=True,
            message=f"✅ '{filename}' confirmed. Processing will begin shortly.",
            data={
                "action": "save",
                "filename": filename,
                "confirmed": True,
            },
        )


def parse_command(text: str) -> tuple[str | None, list[str]]:
    """
    Parse a message text to extract a command and its arguments.

    Args:
        text: The raw message text.

    Returns:
        Tuple of (command, args) if a command is found, or (None, []) otherwise.
    """
    text = text.strip()
    if not text.startswith("/"):
        return None, []

    parts = text.split(maxsplit=1)
    command = parts[0].lower()
    args = parts[1].split() if len(parts) > 1 else []

    return command, args


def is_document_command(text: str) -> bool:
    """
    Check if a message text is a document management command.

    Args:
        text: The message text to check.

    Returns:
        True if the text starts with a known document command.
    """
    normalized = text.strip().lower()
    return any(normalized.startswith(cmd.value) for cmd in CommandType)
