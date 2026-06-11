"""Regression test for Bedrock fallback chain (G_5).

Bug context (2026-05-28): single ThrottlingException could cause sub-agent
to surface an error to the user without trying secondary models. The
sub-agent now walks a fallback chain on Throttling/ServiceUnavailable.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from src.llm.bedrock_client import (
    BedrockClient,
    CircuitBreaker,
    FALLBACK_MODEL_IDS,
    FALLBACK_TRIGGER_ERROR_CODES,
    TaskType,
)


def _make_throttle_error(code: str = "ThrottlingException") -> ClientError:
    return ClientError(
        error_response={"Error": {"Code": code, "Message": "Rate exceeded"}},
        operation_name="InvokeModel",
    )


def _make_success_body(text: str = "ok") -> dict:
    body_dict = {
        "content": [{"type": "text", "text": text}],
        "usage": {"input_tokens": 5, "output_tokens": 7},
        "stop_reason": "end_turn",
    }
    body_obj = MagicMock()
    body_obj.read.return_value = json.dumps(body_dict).encode("utf-8")
    return {"body": body_obj}


@pytest.mark.asyncio
async def test_fallback_chain_constants_exist():
    assert isinstance(FALLBACK_MODEL_IDS, list)
    assert len(FALLBACK_MODEL_IDS) >= 1
    assert "ThrottlingException" in FALLBACK_TRIGGER_ERROR_CODES


@pytest.mark.asyncio
async def test_fallback_skips_throttled_model_and_succeeds_on_secondary():
    boto = MagicMock()
    call_count = {"n": 0}

    def invoke(*, modelId, **_kwargs):
        call_count["n"] += 1
        if modelId == "global.anthropic.claude-sonnet-4-5-20250929-v1:0":
            raise _make_throttle_error()
        return _make_success_body("hello from fallback")

    boto.invoke_model.side_effect = invoke
    client = BedrockClient(
        model_id="global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        boto_client=boto,
        circuit_breaker=CircuitBreaker(failure_threshold=999),
    )
    response = await client.invoke(
        messages=[{"role": "user", "content": "hi"}],
        task_type=TaskType.CHAT,
    )
    assert response.content == "hello from fallback"
    # Primary tried once, immediate fallback (NOT MAX_RETRIES retries) on Throttle
    # Then secondary succeeds first try.
    assert call_count["n"] == 2, f"expected 2 calls, got {call_count}"
    assert response.model_id != "global.anthropic.claude-sonnet-4-5-20250929-v1:0"


@pytest.mark.asyncio
async def test_fallback_chain_exhausts_then_raises():
    boto = MagicMock()
    boto.invoke_model.side_effect = _make_throttle_error()
    client = BedrockClient(
        model_id="global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        boto_client=boto,
        circuit_breaker=CircuitBreaker(failure_threshold=999),
    )
    with pytest.raises(ClientError):
        await client.invoke(
            messages=[{"role": "user", "content": "hi"}],
            task_type=TaskType.CHAT,
        )
    # 1 primary + len(fallbacks) attempts (each immediate-skip on throttle)
    assert boto.invoke_model.call_count == 1 + len(FALLBACK_MODEL_IDS)


@pytest.mark.asyncio
async def test_non_fallback_error_still_retries_on_same_model():
    """Non-throttle errors should still retry MAX_RETRIES times before fallback."""
    boto = MagicMock()
    call_count = {"n": 0}

    def invoke(*, modelId, **_kwargs):
        call_count["n"] += 1
        if modelId == "global.anthropic.claude-sonnet-4-5-20250929-v1:0" and call_count["n"] < 3:
            raise ClientError(
                error_response={"Error": {"Code": "InternalServerError", "Message": "boom"}},
                operation_name="InvokeModel",
            )
        return _make_success_body("ok after retries")

    boto.invoke_model.side_effect = invoke
    client = BedrockClient(
        model_id="global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        boto_client=boto,
        circuit_breaker=CircuitBreaker(failure_threshold=999),
    )
    # Use small backoff via monkeypatch on asyncio.sleep
    orig_sleep = asyncio.sleep
    async def fast_sleep(s):
        await orig_sleep(0)
    import src.llm.bedrock_client as bc
    bc.asyncio.sleep = fast_sleep  # type: ignore
    try:
        response = await client.invoke(
            messages=[{"role": "user", "content": "hi"}],
            task_type=TaskType.CHAT,
        )
    finally:
        bc.asyncio.sleep = orig_sleep  # type: ignore
    assert response.content == "ok after retries"
    # 3 attempts on primary, all on the same model
    assert call_count["n"] == 3
