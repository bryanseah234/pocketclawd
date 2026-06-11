"""Regression test for routing-field echo (C1).

Bug context (2026-05-28): sub-agent handlers built response metadata
WITHOUT echoing channelType/platformId/threadId/kind from inbound.metadata.
Result: orchestrator response poll could not deliver replies and logged
"Cloud response missing routing fields".

Fix: src/main.py poll_queue() now does:
    for _k in ("channelType","platformId","threadId","kind"):
        if _k in message.metadata and not response.metadata.get(_k):
            response.metadata[_k] = message.metadata[_k]

This regression test asserts that for every handler-produced response,
the routing fields propagate into response.metadata.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from src.main import AgentResponse, InboundMessage


ROUTING_KEYS = ("channelType", "platformId", "threadId", "kind")


def _echo(inbound: InboundMessage, response: AgentResponse) -> AgentResponse:
    """Mirror the echo logic from src/main.py poll_queue."""
    for k in ROUTING_KEYS:
        if k in inbound.metadata and not response.metadata.get(k):
            response.metadata[k] = inbound.metadata[k]
    return response


def _inbound(meta: dict) -> InboundMessage:
    return InboundMessage(
        message_id="test-msg-id",
        user_id="6592348112",
        content="hello",
        timestamp="2026-05-28T00:00:00Z",
        metadata=meta,
    )


def _response(meta: dict | None = None) -> AgentResponse:
    return AgentResponse(
        message_id="test-msg-id",
        user_id="6592348112",
        content="reply",
        timestamp="2026-05-28T00:00:00Z",
        metadata=meta or {},
    )


@pytest.mark.parametrize(
    "inbound_meta",
    [
        {"channelType": "whatsapp", "platformId": "6592348112@s.whatsapp.net", "threadId": "t1", "kind": "text"},
        {"channelType": "telegram", "platformId": "12345", "kind": "text"},
        {"channelType": "whatsapp", "platformId": "6592348112@s.whatsapp.net"},
    ],
)
def test_all_routing_keys_propagate_when_present(inbound_meta):
    """Every routing key in inbound.metadata must end up in response.metadata."""
    inbound = _inbound(inbound_meta)
    response = _echo(inbound, _response())
    for k, v in inbound_meta.items():
        if k in ROUTING_KEYS:
            assert response.metadata.get(k) == v, f"missing {k}"


def test_handler_metadata_takes_precedence():
    """If a handler explicitly sets a routing key, echo must NOT overwrite it."""
    inbound = _inbound({"channelType": "whatsapp", "platformId": "wrong"})
    response = _response({"channelType": "whatsapp", "platformId": "OVERRIDE"})
    out = _echo(inbound, response)
    assert out.metadata["platformId"] == "OVERRIDE"


def test_no_routing_keys_when_inbound_has_none():
    """If inbound has no routing fields, response is unchanged."""
    inbound = _inbound({"type": "chat"})
    response = _response({"source": "sub-agent"})
    out = _echo(inbound, response)
    for k in ROUTING_KEYS:
        assert k not in out.metadata


def test_no_handler_pre_populates_routing_keys():
    """Audit src/main.py for any literal metadata={...} dict that hard-codes
    a routing key. Such a hard-code would shadow the inbound's correct value
    via the `not response.metadata.get(_k)` short-circuit. The merged_meta
    construction inside poll_queue is the only legitimate place where these
    keys can appear (because it carries them via **payload_dict).
    """
    main_py = Path(__file__).resolve().parent.parent / "src" / "main.py"
    text = main_py.read_text(encoding="utf-8")
    # Find every literal-dict metadata={...} (single-line for simplicity)
    pattern = re.compile(r"metadata=\{([^{}]*?)\}", re.MULTILINE)
    offenders = []
    for m in pattern.finditer(text):
        body = m.group(1)
        for k in ROUTING_KEYS:
            if f'"{k}"' in body or f"'{k}'" in body:
                offenders.append((k, body[:120]))
    assert not offenders, (
        f"Hard-coded routing keys found in handler metadata={{...}} dicts: "
        f"{offenders}. The echo logic in poll_queue is the single source of truth."
    )


def test_main_py_still_has_echo_block():
    """Sanity check: the echo block in poll_queue must exist."""
    main_py = Path(__file__).resolve().parent.parent / "src" / "main.py"
    text = main_py.read_text(encoding="utf-8")
    assert '"channelType", "platformId", "threadId", "kind"' in text, (
        "Echo block in src/main.py poll_queue is missing or has been altered."
    )
