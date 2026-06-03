"""
Regression tests for RAGPipeline._search no_docs cache behavior.

This pins shut the cache-poisoning bug: below-threshold hits must NOT set the
`cache:no_docs:<user>` short-circuit flag (which would make the next 5 minutes
skip RAG entirely even though the user HAS documents). The flag may only be set
when the raw search returns genuinely empty.

The live agent (src/main.py) wires RAGPipeline from src/rag/pipeline.py -- this is
the module under test. (src/rag/retrieval.py / RAGRetrieval is dead code covered
by test_rag_retrieval.py and is NOT the deployed path.)
"""

import pytest

from src.rag.pipeline import MIN_SIMILARITY_THRESHOLD, RAGPipeline


class FakeRedis:
    """Minimal async Redis fake: tracks setex calls and a single queued response."""

    def __init__(self, exists_keys=None, dg_response=None):
        self._exists = set(exists_keys or [])
        self._dg_response = dg_response  # raw JSON string to return from brpop
        self.setex_calls = []  # list of (key, ttl, val)
        self.lpush_calls = []

    async def exists(self, key):
        return 1 if key in self._exists else 0

    async def setex(self, key, ttl, val):
        self.setex_calls.append((key, ttl, val))
        self._exists.add(key)

    async def lpush(self, key, val):
        self.lpush_calls.append((key, val))

    async def brpop(self, key, timeout=0):
        if self._dg_response is None:
            return None
        return (key, self._dg_response)


def _make_pipeline(redis):
    # embedding_pipeline / llm_client are unused by _search; pass simple stand-ins.
    return RAGPipeline(
        redis_client=redis,
        user_id="user-test",
        embedding_pipeline=object(),
        llm_client=object(),
    )


def _dg_payload(results):
    import json

    return json.dumps({"success": True, "results": results})


# ---------------------------------------------------------------------------
# The bug: below-threshold must NOT poison the no_docs cache
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_below_threshold_does_not_set_no_docs_cache():
    """A single low-scoring hit must not set cache:no_docs (the regression)."""
    low = 0.54
    assert low < MIN_SIMILARITY_THRESHOLD
    redis = FakeRedis(dg_response=_dg_payload([
        {"score": low, "filename": "notes.pdf", "content": "vaguely related text"},
    ]))
    pipeline = _make_pipeline(redis)

    out = await pipeline._search("vague query", [0.1] * 1536)

    # No cache poisoning.
    assert redis.setex_calls == [], "below-threshold must NOT setex cache:no_docs"
    # Fall back to top raw hit(s) so doc content still reaches the LLM.
    assert len(out) >= 1
    assert out[0]["filename"] == "notes.pdf"


@pytest.mark.asyncio
async def test_below_threshold_returns_top_two_raw_hits_sorted():
    """Below-threshold fallback returns the top-2 raw hits, highest score first."""
    redis = FakeRedis(dg_response=_dg_payload([
        {"score": 0.31, "filename": "c.pdf", "content": "c"},
        {"score": 0.58, "filename": "a.pdf", "content": "a"},
        {"score": 0.42, "filename": "b.pdf", "content": "b"},
    ]))
    pipeline = _make_pipeline(redis)

    out = await pipeline._search("q", [0.1] * 1536)

    assert redis.setex_calls == []
    assert [r["filename"] for r in out] == ["a.pdf", "b.pdf"]


# ---------------------------------------------------------------------------
# Correct behaviors that must remain intact
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_truly_empty_results_sets_no_docs_cache():
    """Genuinely empty index DOES set cache:no_docs for 5 min and returns []."""
    redis = FakeRedis(dg_response=_dg_payload([]))
    pipeline = _make_pipeline(redis)

    out = await pipeline._search("q", [0.1] * 1536)

    assert out == []
    assert len(redis.setex_calls) == 1
    key, ttl, val = redis.setex_calls[0]
    assert key == "cache:no_docs:user-test"
    assert ttl == 300


@pytest.mark.asyncio
async def test_above_threshold_returns_filtered_no_cache():
    """At/above threshold returns filtered hits and never touches the cache."""
    redis = FakeRedis(dg_response=_dg_payload([
        {"score": 0.91, "filename": "good.pdf", "content": "highly relevant"},
        {"score": 0.40, "filename": "bad.pdf", "content": "irrelevant"},
    ]))
    pipeline = _make_pipeline(redis)

    out = await pipeline._search("q", [0.1] * 1536)

    assert redis.setex_calls == []
    assert [r["filename"] for r in out] == ["good.pdf"]
    assert all(r["score"] >= MIN_SIMILARITY_THRESHOLD for r in out)


@pytest.mark.asyncio
async def test_existing_no_docs_cache_short_circuits_search():
    """If cache:no_docs is already set, _search returns [] without querying DG."""
    redis = FakeRedis(exists_keys={"cache:no_docs:user-test"})
    pipeline = _make_pipeline(redis)

    out = await pipeline._search("q", [0.1] * 1536)

    assert out == []
    assert redis.lpush_calls == [], "must not enqueue a DG request when short-circuited"
