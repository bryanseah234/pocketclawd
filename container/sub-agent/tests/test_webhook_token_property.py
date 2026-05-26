"""
Property-based tests for webhook token lifecycle.

Feature: nanoclaw-aws-deployment, Property 6: Webhook token lifecycle

**Validates: Requirements REQ-5.2**

Properties tested:
- Token valid within 15 min on first use (create → validate within TTL → success)
- Token invalid on second use (one-time use enforcement)
- Token invalid after 15 min (expiry enforcement)

The WebhookTokenManager communicates with the orchestrator via Redis. These tests
simulate the orchestrator's responses to verify the token lifecycle contract:
- The orchestrator stores the token hash in DynamoDB with a 15-min TTL
- On first validation within TTL, the orchestrator deletes the token and responds valid=True
- On second validation (token already consumed), the orchestrator responds valid=False
- On validation after TTL expiry, the orchestrator responds valid=False
"""

import hashlib
import json
import time
from unittest.mock import patch

import pytest
from hypothesis import given, settings, assume, strategies as st

from src.documents.commands import (
    TOKEN_EXPIRY_SECONDS,
    WebhookToken,
    WebhookTokenManager,
)


# ---------------------------------------------------------------------------
# Simulated Orchestrator Token Store
# ---------------------------------------------------------------------------


class SimulatedOrchestratorTokenStore:
    """
    Simulates the orchestrator's DynamoDB-backed token store behavior.

    This mimics what the orchestrator does when it receives token requests:
    - create_webhook_token: stores the hash with a TTL
    - validate_webhook_token: checks existence, TTL, and consumes (deletes) on success
    """

    def __init__(self):
        # token_hash -> {"created_at": float, "expires_at": float}
        self._tokens: dict[str, dict] = {}
        self._current_time: float = time.time()

    def set_current_time(self, t: float) -> None:
        """Set the simulated current time for expiry checks."""
        self._current_time = t

    def store_token(self, token_hash: str, created_at: float, expires_at: float) -> None:
        """Store a token hash (simulates DynamoDB put with TTL)."""
        self._tokens[token_hash] = {
            "created_at": created_at,
            "expires_at": expires_at,
        }

    def validate_and_consume(self, token_hash: str) -> bool:
        """
        Validate a token hash and consume it (one-time use).

        Returns True if:
        - Token exists in store
        - Token has not expired (current_time <= expires_at)

        On success, the token is deleted (consumed).
        """
        if token_hash not in self._tokens:
            return False

        token_data = self._tokens[token_hash]
        if self._current_time > token_data["expires_at"]:
            # Expired — remove and reject
            del self._tokens[token_hash]
            return False

        # Valid — consume (delete) and accept
        del self._tokens[token_hash]
        return True


class FakeRedisWithOrchestrator:
    """
    Fake Redis client that simulates the orchestrator's token management behavior.

    When the WebhookTokenManager sends a create_webhook_token request, this fake
    stores the token in the simulated orchestrator. When a validate_webhook_token
    request arrives, it checks the simulated store and responds accordingly.
    """

    def __init__(self, orchestrator: SimulatedOrchestratorTokenStore, user_id: str):
        self._orchestrator = orchestrator
        self._user_id = user_id
        self._queues: dict[str, list[str]] = {}

    async def lpush(self, key: str, value: str) -> int:
        """Handle requests sent to the orchestrator queue."""
        request = json.loads(value)
        action = request.get("action")

        if action == "create_webhook_token":
            # Orchestrator stores the token
            self._orchestrator.store_token(
                token_hash=request["token_hash"],
                created_at=request["created_at"],
                expires_at=request["expires_at"],
            )
        elif action == "validate_webhook_token":
            # Orchestrator validates and responds
            token_hash = request["token_hash"]
            request_id = request["request_id"]
            is_valid = self._orchestrator.validate_and_consume(token_hash)

            # Store the response for brpop to pick up
            response_key = f"queue:agent:{self._user_id}:token_response:{request_id}"
            if response_key not in self._queues:
                self._queues[response_key] = []
            self._queues[response_key].append(json.dumps({"valid": is_valid}))

        return 1

    async def brpop(self, key: str, timeout: int = 0) -> tuple[str, str] | None:
        """Return pre-computed orchestrator responses."""
        if key in self._queues and self._queues[key]:
            return (key, self._queues[key].pop(0))
        return None


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

# Generate realistic user IDs
user_id_strategy = st.text(
    alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="-_"),
    min_size=3,
    max_size=30,
)

# Generate timestamps within a reasonable range (past year to next year)
base_time = time.time()
timestamp_strategy = st.floats(
    min_value=base_time - 365 * 86400,
    max_value=base_time + 365 * 86400,
    allow_nan=False,
    allow_infinity=False,
)

# Time offsets within the valid window (0 to just under 15 minutes)
valid_offset_strategy = st.floats(
    min_value=0.0,
    max_value=TOKEN_EXPIRY_SECONDS - 1.0,
    allow_nan=False,
    allow_infinity=False,
)

# Time offsets beyond the expiry window (15 minutes + some buffer)
expired_offset_strategy = st.floats(
    min_value=TOKEN_EXPIRY_SECONDS + 0.001,
    max_value=TOKEN_EXPIRY_SECONDS + 86400,  # up to 1 day past expiry
    allow_nan=False,
    allow_infinity=False,
)


# ---------------------------------------------------------------------------
# Property Tests
# ---------------------------------------------------------------------------


class TestTokenValidWithinWindow:
    """Property 6: Token valid within 15 min on first use."""

    @given(
        user_id=user_id_strategy,
        creation_time=timestamp_strategy,
        validation_offset=valid_offset_strategy,
    )
    @settings(max_examples=100, deadline=None)
    @pytest.mark.asyncio
    async def test_token_valid_on_first_use_within_expiry(
        self, user_id, creation_time, validation_offset
    ):
        """
        For any generated token, validating its SHA-256 hash within 15 minutes
        of creation SHALL succeed on first use.

        Feature: nanoclaw-aws-deployment, Property 6: Webhook token lifecycle
        **Validates: Requirements REQ-5.2**
        """
        assume(len(user_id.strip()) > 0)

        orchestrator = SimulatedOrchestratorTokenStore()
        fake_redis = FakeRedisWithOrchestrator(orchestrator, user_id)
        manager = WebhookTokenManager(redis_client=fake_redis, user_id=user_id)

        # Patch time.time() to control token creation timestamp
        with patch("src.documents.commands.time.time", return_value=creation_time):
            token = await manager.create_save_token()

        # Set orchestrator time to within the valid window
        validation_time = creation_time + validation_offset
        orchestrator.set_current_time(validation_time)

        # First validation should succeed
        result = await manager.validate_token(token.raw_token)
        assert result is True, (
            f"Token should be valid on first use within {validation_offset:.1f}s "
            f"of creation (TTL={TOKEN_EXPIRY_SECONDS}s)"
        )


class TestTokenInvalidOnSecondUse:
    """Property 6: Token invalid on second use (one-time use)."""

    @given(
        user_id=user_id_strategy,
        creation_time=timestamp_strategy,
        validation_offset=valid_offset_strategy,
    )
    @settings(max_examples=100, deadline=None)
    @pytest.mark.asyncio
    async def test_token_invalid_on_second_use(
        self, user_id, creation_time, validation_offset
    ):
        """
        For any generated token, validating the same token hash a second time
        SHALL fail (one-time use enforcement).

        Feature: nanoclaw-aws-deployment, Property 6: Webhook token lifecycle
        **Validates: Requirements REQ-5.2**
        """
        assume(len(user_id.strip()) > 0)

        orchestrator = SimulatedOrchestratorTokenStore()
        fake_redis = FakeRedisWithOrchestrator(orchestrator, user_id)
        manager = WebhookTokenManager(redis_client=fake_redis, user_id=user_id)

        # Create token
        with patch("src.documents.commands.time.time", return_value=creation_time):
            token = await manager.create_save_token()

        # Set time within valid window
        validation_time = creation_time + validation_offset
        orchestrator.set_current_time(validation_time)

        # First use — should succeed
        first_result = await manager.validate_token(token.raw_token)
        assert first_result is True, "First validation should succeed"

        # Second use — should fail (token consumed)
        second_result = await manager.validate_token(token.raw_token)
        assert second_result is False, (
            "Second validation of the same token should fail (one-time use). "
            f"Token was already consumed on first validation."
        )


class TestTokenInvalidAfterExpiry:
    """Property 6: Token invalid after 15 min (expiry enforcement)."""

    @given(
        user_id=user_id_strategy,
        creation_time=timestamp_strategy,
        expired_offset=expired_offset_strategy,
    )
    @settings(max_examples=100, deadline=None)
    @pytest.mark.asyncio
    async def test_token_invalid_after_expiry(
        self, user_id, creation_time, expired_offset
    ):
        """
        For any generated token, validating any token hash after 15 minutes
        from creation SHALL fail (expiry enforcement).

        Feature: nanoclaw-aws-deployment, Property 6: Webhook token lifecycle
        **Validates: Requirements REQ-5.2**
        """
        assume(len(user_id.strip()) > 0)

        orchestrator = SimulatedOrchestratorTokenStore()
        fake_redis = FakeRedisWithOrchestrator(orchestrator, user_id)
        manager = WebhookTokenManager(redis_client=fake_redis, user_id=user_id)

        # Create token
        with patch("src.documents.commands.time.time", return_value=creation_time):
            token = await manager.create_save_token()

        # Set time beyond expiry window
        validation_time = creation_time + expired_offset
        orchestrator.set_current_time(validation_time)

        # Validation after expiry should fail
        result = await manager.validate_token(token.raw_token)
        assert result is False, (
            f"Token should be invalid after {expired_offset:.1f}s "
            f"(TTL={TOKEN_EXPIRY_SECONDS}s = 15 min)"
        )


class TestTokenHashConsistency:
    """
    Supporting property: SHA-256 hash used for validation matches the one stored.

    This ensures the token lifecycle is internally consistent — the hash computed
    at creation time is the same hash used during validation.
    """

    @given(user_id=user_id_strategy, creation_time=timestamp_strategy)
    @settings(max_examples=100, deadline=None)
    @pytest.mark.asyncio
    async def test_hash_at_creation_matches_hash_at_validation(
        self, user_id, creation_time
    ):
        """
        The SHA-256 hash computed during token creation must equal the hash
        computed from the raw token during validation.

        Feature: nanoclaw-aws-deployment, Property 6: Webhook token lifecycle
        **Validates: Requirements REQ-5.2**
        """
        assume(len(user_id.strip()) > 0)

        # Track what hash was stored
        stored_hashes: list[str] = []

        orchestrator = SimulatedOrchestratorTokenStore()
        original_store = orchestrator.store_token

        def tracking_store(token_hash, created_at, expires_at):
            stored_hashes.append(token_hash)
            original_store(token_hash, created_at, expires_at)

        orchestrator.store_token = tracking_store

        fake_redis = FakeRedisWithOrchestrator(orchestrator, user_id)
        manager = WebhookTokenManager(redis_client=fake_redis, user_id=user_id)

        with patch("src.documents.commands.time.time", return_value=creation_time):
            token = await manager.create_save_token()

        # Verify the stored hash matches what we'd compute from the raw token
        assert len(stored_hashes) == 1
        expected_hash = hashlib.sha256(token.raw_token.encode("utf-8")).hexdigest()
        assert stored_hashes[0] == expected_hash, (
            f"Stored hash {stored_hashes[0]} != computed hash {expected_hash}"
        )

        # Also verify the token object's hash matches
        assert token.token_hash == expected_hash
