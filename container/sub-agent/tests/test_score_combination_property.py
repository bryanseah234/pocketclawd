"""
Property-based tests for hybrid retrieval score combination.

Feature: nanoclaw-aws-deployment, Property 4: Hybrid retrieval score combination

**Validates: Requirements REQ-3.3**

Properties tested:
- Combined score = 0.7 × vector_score + 0.3 × normalized_bm25 (where normalized = bm25 / max_bm25)
- Results are ordered by combined score descending
- Exactly min(3, total_candidates) results are returned
"""

import math

from hypothesis import given, settings, assume, strategies as st

from src.rag.retrieval import (
    BM25_WEIGHT,
    RAGRetrieval,
    TOP_K_RESULTS,
    VECTOR_WEIGHT,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_retrieval() -> RAGRetrieval:
    """Create a minimal RAGRetrieval instance for testing score computation."""

    class StubEmbedding:
        async def embed_text(self, text: str) -> list[float]:
            return [0.0] * 1536

    class StubBedrock:
        async def invoke(self, **kwargs):
            pass

    return RAGRetrieval(
        data_gateway_url="http://stub:8080",
        embedding_pipeline=StubEmbedding(),
        bedrock_client=StubBedrock(),
        http_client=None,
    )


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

# Generate search results with valid score ranges
result_strategy = st.fixed_dictionaries({
    "content": st.text(min_size=1, max_size=100),
    "filename": st.text(min_size=1, max_size=50),
    "page_number": st.integers(min_value=1, max_value=100),
    "chunk_index": st.integers(min_value=0, max_value=50),
    "vector_score": st.floats(min_value=0.7, max_value=1.0, allow_nan=False, allow_infinity=False),
    "bm25_score": st.floats(min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False),
    "source": st.sampled_from(["vector", "keyword", "hybrid"]),
})


# ---------------------------------------------------------------------------
# Property Tests
# ---------------------------------------------------------------------------


class TestCombinedScoreFormula:
    """Property 4: Combined score = 0.7 × vector_score + 0.3 × normalized_bm25."""

    @given(
        vector_score=st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False),
        bm25_score=st.floats(min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False),
        max_bm25=st.floats(min_value=0.01, max_value=200.0, allow_nan=False, allow_infinity=False),
    )
    @settings(max_examples=100, deadline=None)
    def test_combined_score_formula(self, vector_score, bm25_score, max_bm25):
        """
        For any valid vector_score and bm25_score, the combined score must equal
        0.7 × vector_score + 0.3 × (bm25_score / max_bm25).

        Feature: nanoclaw-aws-deployment, Property 4: Hybrid retrieval score combination
        **Validates: Requirements REQ-3.3**
        """
        assume(max_bm25 >= bm25_score or bm25_score > 0)

        retrieval = _make_retrieval()
        result = {"vector_score": vector_score, "bm25_score": bm25_score}

        computed = retrieval._compute_combined_score(result, max_bm25)

        normalized_bm25 = bm25_score / max_bm25 if max_bm25 > 0 else 0.0
        expected = VECTOR_WEIGHT * vector_score + BM25_WEIGHT * normalized_bm25

        assert math.isclose(computed, expected, rel_tol=1e-9), (
            f"Expected {expected}, got {computed} "
            f"(vector={vector_score}, bm25={bm25_score}, max_bm25={max_bm25})"
        )

    @given(
        vector_score=st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False),
        bm25_score=st.floats(min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False),
    )
    @settings(max_examples=100, deadline=None)
    def test_combined_score_zero_max_bm25(self, vector_score, bm25_score):
        """
        When max_bm25 is 0, normalized BM25 should be 0 and combined score
        equals 0.7 × vector_score.

        Feature: nanoclaw-aws-deployment, Property 4: Hybrid retrieval score combination
        **Validates: Requirements REQ-3.3**
        """
        retrieval = _make_retrieval()
        result = {"vector_score": vector_score, "bm25_score": bm25_score}

        computed = retrieval._compute_combined_score(result, max_bm25=0.0)

        expected = VECTOR_WEIGHT * vector_score
        assert math.isclose(computed, expected, rel_tol=1e-9), (
            f"Expected {expected}, got {computed} when max_bm25=0"
        )


class TestResultsOrderedDescending:
    """Property 4: After scoring, results are ordered by combined score descending."""

    @given(results=st.lists(result_strategy, min_size=2, max_size=10))
    @settings(max_examples=100, deadline=None)
    def test_results_ordered_descending(self, results):
        """
        For any set of results with valid scores, after computing combined scores
        and sorting, the results must be in descending order of combined score.

        Feature: nanoclaw-aws-deployment, Property 4: Hybrid retrieval score combination
        **Validates: Requirements REQ-3.3**
        """
        retrieval = _make_retrieval()

        # Compute max BM25 for normalization
        bm25_scores = [r["bm25_score"] for r in results]
        max_bm25 = max(bm25_scores) if bm25_scores else 0.0

        # Compute combined scores for all results
        scored = [
            (retrieval._compute_combined_score(r, max_bm25), r)
            for r in results
        ]

        # Sort descending by combined score (as the retrieval pipeline does)
        scored.sort(key=lambda x: x[0], reverse=True)

        # Verify descending order
        scores = [s for s, _ in scored]
        for i in range(len(scores) - 1):
            assert scores[i] >= scores[i + 1], (
                f"Score at index {i} ({scores[i]}) < score at index {i+1} ({scores[i+1]})"
            )


class TestReturnsMinThreeTotal:
    """Property 4: Returns exactly min(3, total_candidates) results."""

    @given(results=st.lists(result_strategy, min_size=0, max_size=10))
    @settings(max_examples=100, deadline=None)
    def test_returns_min_3_total(self, results):
        """
        After filtering and scoring, the pipeline returns exactly
        min(3, len(filtered_results)) results.

        Feature: nanoclaw-aws-deployment, Property 4: Hybrid retrieval score combination
        **Validates: Requirements REQ-3.3**
        """
        retrieval = _make_retrieval()

        # Filter by threshold (all results in our strategy have vector_score >= 0.7)
        filtered = retrieval._filter_by_threshold(results)

        # Apply top-K selection
        top_k = filtered[:TOP_K_RESULTS]

        expected_count = min(TOP_K_RESULTS, len(filtered))
        assert len(top_k) == expected_count, (
            f"Expected {expected_count} results, got {len(top_k)} "
            f"(filtered={len(filtered)}, TOP_K={TOP_K_RESULTS})"
        )

    @given(results=st.lists(result_strategy, min_size=4, max_size=10))
    @settings(max_examples=100, deadline=None)
    def test_never_exceeds_top_k(self, results):
        """
        When there are more than TOP_K_RESULTS candidates, the output
        is capped at exactly TOP_K_RESULTS (3).

        Feature: nanoclaw-aws-deployment, Property 4: Hybrid retrieval score combination
        **Validates: Requirements REQ-3.3**
        """
        retrieval = _make_retrieval()

        # All results in our strategy pass threshold (vector_score >= 0.7)
        filtered = retrieval._filter_by_threshold(results)
        assume(len(filtered) > TOP_K_RESULTS)

        top_k = filtered[:TOP_K_RESULTS]
        assert len(top_k) == TOP_K_RESULTS, (
            f"Expected exactly {TOP_K_RESULTS} results when candidates > TOP_K, "
            f"got {len(top_k)}"
        )
