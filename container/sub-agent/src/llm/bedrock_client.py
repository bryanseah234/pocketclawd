"""
Bedrock LLM client with circuit breaker and retry logic.

Wraps Amazon Bedrock InvokeModel for Claude 3.5 Sonnet with:
- Task-specific temperature configuration
- Max 4096 output tokens per response
- Circuit breaker: closed → open (5 failures or >50% in 60s) → half-open (30s cooldown)
- Retry with exponential backoff (1s, 2s, 4s) up to 3 retries

Requirements: REQ-3.1
"""

import asyncio
import json
import logging
import os
import time
from collections import deque
from enum import Enum
from typing import Any

import boto3
from botocore.exceptions import ClientError
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-4-5-20250929-v1:0"

# Fallback chain for ThrottlingException / ServiceUnavailable scenarios (G_5).
# Order: best-but-most-throttled -> regional fallback -> cheap-and-fast fallback.
# Each tier is tried only after MAX_RETRIES is exhausted on the previous one.
# WARNING: Bedrock model IDs in ap-southeast-1 are version-specific. Use
# `aws bedrock list-inference-profiles --region ap-southeast-1` if these
# stop resolving. Sonnet 4.5 currently exists ONLY as `global.*`, Sonnet 4
# only as `apac.*`, Haiku 4.5 as `apac.*`.
FALLBACK_MODEL_IDS = [
    "apac.anthropic.claude-sonnet-4-20250514-v1:0",
    "apac.anthropic.claude-haiku-4-5-20251001-v1:0",
]

# Errors that should trigger fallback to the next model (vs hard fail).
FALLBACK_TRIGGER_ERROR_CODES = frozenset({
    "ThrottlingException",
    "ServiceUnavailableException",
    "ModelNotReadyException",
    "ModelTimeoutException",
})
MAX_OUTPUT_TOKENS = 4096

# Circuit breaker thresholds
CB_FAILURE_THRESHOLD = 5
CB_FAILURE_RATE_THRESHOLD = 0.50  # 50%
CB_WINDOW_SECONDS = 60
CB_COOLDOWN_SECONDS = 30

# Retry configuration
MAX_RETRIES = 3
BACKOFF_BASE_SECONDS = 1.0  # 1s, 2s, 4s


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


class TaskType(str, Enum):
    """Supported task types with associated temperature settings."""

    CHAT = "chat"
    SUMMARIZATION = "summarization"
    SLIDES = "slides"
    RAG_QA = "rag_qa"


# Temperature mapping per task type
TASK_TEMPERATURES: dict[TaskType, float] = {
    TaskType.CHAT: 0.5,
    TaskType.SUMMARIZATION: 0.3,
    TaskType.SLIDES: 0.8,
    TaskType.RAG_QA: 0.2,
}


class CircuitState(str, Enum):
    """Circuit breaker states."""

    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitBreakerOpenError(Exception):
    """Raised when the circuit breaker is open and requests are rejected."""

    pass


_CACHED_MODEL_ID: str | None = None


def _load_model_id_from_secrets(secret_id: str) -> str | None:
    """
    Resolve ``llm_subagent_model_id`` from AWS Secrets Manager.

    Falls back silently to None on any error so the caller can keep using the
    DEFAULT_MODEL_ID. Result is cached per-process.
    """
    global _CACHED_MODEL_ID
    if _CACHED_MODEL_ID is not None:
        return _CACHED_MODEL_ID
    region = os.environ.get("AWS_REGION", "ap-southeast-1")
    client = boto3.client("secretsmanager", region_name=region)
    resp = client.get_secret_value(SecretId=secret_id)
    raw_str = resp.get("SecretString")
    if not raw_str:
        return None
    config = json.loads(raw_str)
    model_id = config.get("llm_subagent_model_id") or config.get("llm_model_id")
    if model_id:
        _CACHED_MODEL_ID = model_id
        logger.info("Sub-agent model id resolved from %s: %s", secret_id, model_id)
    return model_id


class LLMResponse(BaseModel):
    """Response from the Bedrock LLM."""

    content: str
    model_id: str
    input_tokens: int = 0
    output_tokens: int = 0
    stop_reason: str = ""


# ---------------------------------------------------------------------------
# Circuit Breaker
# ---------------------------------------------------------------------------


class CircuitBreaker:
    """
    Circuit breaker implementation with three states.

    - Closed (normal): requests pass through, failures are tracked.
    - Open (tripped): after 5 failures or >50% failure rate in 60s window,
      all requests are rejected immediately.
    - Half-Open (recovery): after 30s cooldown, one probe request is allowed.
      If it succeeds, circuit closes. If it fails, circuit reopens.
    """

    def __init__(
        self,
        failure_threshold: int = CB_FAILURE_THRESHOLD,
        failure_rate_threshold: float = CB_FAILURE_RATE_THRESHOLD,
        window_seconds: float = CB_WINDOW_SECONDS,
        cooldown_seconds: float = CB_COOLDOWN_SECONDS,
    ) -> None:
        self.failure_threshold = failure_threshold
        self.failure_rate_threshold = failure_rate_threshold
        self.window_seconds = window_seconds
        self.cooldown_seconds = cooldown_seconds

        self._state = CircuitState.CLOSED
        # Track outcomes as (timestamp, success: bool) tuples
        self._outcomes: deque[tuple[float, bool]] = deque()
        self._opened_at: float = 0.0
        self._lock = asyncio.Lock()

    @property
    def state(self) -> CircuitState:
        """Current circuit breaker state."""
        return self._state

    def _now(self) -> float:
        """Current monotonic time. Overridable for testing."""
        return time.monotonic()

    def _prune_window(self) -> None:
        """Remove outcomes older than the tracking window."""
        cutoff = self._now() - self.window_seconds
        while self._outcomes and self._outcomes[0][0] < cutoff:
            self._outcomes.popleft()

    def _should_trip(self) -> bool:
        """Check if the circuit should trip to open state."""
        self._prune_window()
        if not self._outcomes:
            return False

        failures = sum(1 for _, success in self._outcomes if not success)

        # Trip on absolute failure count
        if failures >= self.failure_threshold:
            return True

        # Trip on failure rate
        total = len(self._outcomes)
        if total > 0 and (failures / total) > self.failure_rate_threshold:
            return True

        return False

    async def allow_request(self) -> bool:
        """
        Check if a request is allowed through the circuit breaker.

        Returns True if the request can proceed, False if it should be rejected.
        """
        async with self._lock:
            if self._state == CircuitState.CLOSED:
                return True

            if self._state == CircuitState.OPEN:
                elapsed = self._now() - self._opened_at
                if elapsed >= self.cooldown_seconds:
                    # Transition to half-open: allow one probe
                    self._state = CircuitState.HALF_OPEN
                    logger.info("Circuit breaker transitioning to HALF_OPEN (cooldown elapsed)")
                    return True
                return False

            if self._state == CircuitState.HALF_OPEN:
                # Only one probe allowed in half-open; reject additional requests
                return False

            return False  # pragma: no cover

    async def record_success(self) -> None:
        """Record a successful request outcome."""
        async with self._lock:
            self._outcomes.append((self._now(), True))

            if self._state == CircuitState.HALF_OPEN:
                # Probe succeeded — close the circuit
                self._state = CircuitState.CLOSED
                logger.info("Circuit breaker CLOSED (probe succeeded)")

    async def record_failure(self) -> None:
        """Record a failed request outcome."""
        async with self._lock:
            self._outcomes.append((self._now(), False))

            if self._state == CircuitState.HALF_OPEN:
                # Probe failed — reopen the circuit
                self._state = CircuitState.OPEN
                self._opened_at = self._now()
                logger.warning("Circuit breaker re-OPENED (probe failed in half-open)")
            elif self._state == CircuitState.CLOSED:
                if self._should_trip():
                    self._state = CircuitState.OPEN
                    self._opened_at = self._now()
                    logger.warning(
                        "Circuit breaker OPENED (threshold exceeded: %d outcomes in window)",
                        len(self._outcomes),
                    )

    async def reset(self) -> None:
        """Reset the circuit breaker to closed state. Useful for testing."""
        async with self._lock:
            self._state = CircuitState.CLOSED
            self._outcomes.clear()
            self._opened_at = 0.0


# ---------------------------------------------------------------------------
# Bedrock Client
# ---------------------------------------------------------------------------


class BedrockClient:
    """
    Amazon Bedrock LLM client with circuit breaker and retry logic.

    Usage:
        client = BedrockClient(region="ap-southeast-1")
        response = await client.invoke(
            messages=[{"role": "user", "content": "Hello"}],
            task_type=TaskType.CHAT,
        )
    """

    def __init__(
        self,
        region: str = "ap-southeast-1",
        model_id: str = DEFAULT_MODEL_ID,
        circuit_breaker: CircuitBreaker | None = None,
        boto_client: Any = None,
    ) -> None:
        self.region = region
        # Honour env override for the deployed model when caller did not pass an explicit one.
        env_model = os.environ.get("BEDROCK_LLM_MODEL_ID")
        if model_id == DEFAULT_MODEL_ID and env_model:
            model_id = env_model
        # If still on default, try AWS Secrets Manager (PRD path)
        if model_id == DEFAULT_MODEL_ID:
            secret_id = os.environ.get("APP_CONFIG_SECRET_ID", "nanoclaw/app-config")
            try:
                resolved = _load_model_id_from_secrets(secret_id)
                if resolved:
                    model_id = resolved
            except Exception as e:  # noqa: BLE001 — best-effort, never blocks startup
                logger.warning(
                    "Could not resolve sub-agent model id from secret %s: %s",
                    secret_id,
                    e,
                )
        self.model_id = model_id
        self.circuit_breaker = circuit_breaker or CircuitBreaker()

        # Allow injecting a boto3 client for testing
        if boto_client is not None:
            self._client = boto_client
        else:
            self._client = boto3.client(
                "bedrock-runtime",
                region_name=region,
            )

    def _build_request_body(
        self,
        messages: list[dict[str, str]],
        task_type: TaskType,
        system_prompt: str | None = None,
        max_tokens: int = MAX_OUTPUT_TOKENS,
    ) -> dict[str, Any]:
        """Build the Bedrock InvokeModel request body for Claude."""
        temperature = TASK_TEMPERATURES[task_type]

        body: dict[str, Any] = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": min(max_tokens, MAX_OUTPUT_TOKENS),
            "temperature": temperature,
            "messages": messages,
        }

        if system_prompt:
            body["system"] = system_prompt

        return body

    async def invoke(
        self,
        messages: list[dict[str, str]],
        task_type: TaskType,
        system_prompt: str | None = None,
        max_tokens: int = MAX_OUTPUT_TOKENS,
    ) -> LLMResponse:
        """
        Invoke the Bedrock LLM with circuit breaker and retry logic.

        Args:
            messages: List of message dicts with 'role' and 'content' keys.
            task_type: The task type determining temperature.
            system_prompt: Optional system prompt.
            max_tokens: Maximum output tokens (capped at 4096).

        Returns:
            LLMResponse with the generated content and metadata.

        Raises:
            CircuitBreakerOpenError: If the circuit breaker is open.
            ClientError: If all retries are exhausted.
        """
        # Check circuit breaker
        if not await self.circuit_breaker.allow_request():
            raise CircuitBreakerOpenError(
                "Circuit breaker is open — LLM requests are temporarily rejected. "
                "Please retry after cooldown."
            )

        body = self._build_request_body(messages, task_type, system_prompt, max_tokens)
        last_error: Exception | None = None

        # G_5: Fallback chain. Try the configured model_id first, then walk
        # through FALLBACK_MODEL_IDS on ThrottlingException / ServiceUnavailable.
        # Each model gets its own MAX_RETRIES retry loop with exponential backoff.
        # The circuit breaker only records a hard failure if the entire chain
        # fails — a fallback is treated as a degraded success for the breaker.
        chain = [self.model_id] + [m for m in FALLBACK_MODEL_IDS if m != self.model_id]

        for chain_idx, candidate_model in enumerate(chain):
            chain_failed = False
            for attempt in range(MAX_RETRIES):
                try:
                    response = await self._call_bedrock(body, model_id_override=candidate_model)
                    if chain_idx > 0:
                        logger.warning(
                            "Bedrock fallback succeeded via %s (primary=%s)",
                            candidate_model,
                            self.model_id,
                        )
                    await self.circuit_breaker.record_success()
                    return response

                except ClientError as e:
                    last_error = e
                    err_code = e.response.get("Error", {}).get("Code", "")
                    logger.warning(
                        "Bedrock invoke attempt %d/%d on %s failed: %s (code=%s)",
                        attempt + 1,
                        MAX_RETRIES,
                        candidate_model,
                        str(e),
                        err_code,
                    )
                    # If fallback-trigger error, abort retries on this model
                    # and move to the next model in the chain immediately.
                    if err_code in FALLBACK_TRIGGER_ERROR_CODES:
                        chain_failed = True
                        break
                    if attempt < MAX_RETRIES - 1:
                        backoff = BACKOFF_BASE_SECONDS * (2**attempt)
                        logger.info("Retrying in %.1fs...", backoff)
                        await asyncio.sleep(backoff)

                except Exception as e:  # noqa: BLE001 — keep prior catchall behaviour
                    last_error = e
                    logger.warning(
                        "Bedrock invoke attempt %d/%d on %s failed: %s",
                        attempt + 1,
                        MAX_RETRIES,
                        candidate_model,
                        str(e),
                    )
                    if attempt < MAX_RETRIES - 1:
                        backoff = BACKOFF_BASE_SECONDS * (2**attempt)
                        logger.info("Retrying in %.1fs...", backoff)
                        await asyncio.sleep(backoff)
            if chain_failed and chain_idx + 1 < len(chain):
                logger.warning(
                    "Bedrock model %s tripped fallback trigger; trying %s next",
                    candidate_model,
                    chain[chain_idx + 1],
                )
                continue
            # If we reach here without returning, this model is exhausted.
            # Move on to the next model in the chain.
            if chain_idx + 1 < len(chain):
                logger.warning(
                    "Bedrock model %s exhausted retries; trying %s next",
                    candidate_model,
                    chain[chain_idx + 1],
                )

        # All models in the chain exhausted — record failure for circuit breaker
        await self.circuit_breaker.record_failure()
        logger.error(
            "All %d models in fallback chain exhausted. Last error: %s",
            len(chain),
            last_error,
        )
        raise last_error  # type: ignore[misc]

    async def _call_bedrock(
        self,
        body: dict[str, Any],
        model_id_override: str | None = None,
    ) -> LLMResponse:
        """
        Execute the actual Bedrock InvokeModel call.

        Runs the synchronous boto3 call in a thread executor to avoid
        blocking the async event loop.

        Args:
            body: InvokeModel request body.
            model_id_override: Override the configured self.model_id (used by
                the G_5 fallback chain to try a secondary model on throttle).
        """
        effective_model_id = model_id_override or self.model_id
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: self._client.invoke_model(
                modelId=effective_model_id,
                contentType="application/json",
                accept="application/json",
                body=json.dumps(body),
            ),
        )

        response_body = json.loads(response["body"].read())

        # Parse Claude response format
        content = ""
        if "content" in response_body and response_body["content"]:
            content_blocks = response_body["content"]
            content = "".join(
                block.get("text", "") for block in content_blocks if block.get("type") == "text"
            )

        usage = response_body.get("usage", {})

        return LLMResponse(
            content=content,
            model_id=effective_model_id,
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            stop_reason=response_body.get("stop_reason", ""),
        )
