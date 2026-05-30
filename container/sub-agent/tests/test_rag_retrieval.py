"""
Unit tests for RAG retrieval pipeline.

Tests cover:
- Hybrid search with threshold filtering
- Cross-encoder reranking via mocked Bedrock
- Top 3 chunk selection with source attribution
- Conversation history trimming (30 messages / 3000 tokens)
- Context building with source attribution formatting
- Score parsing edge cases
"""

import pytest

from src.llm.bedrock_client import LLMResponse
from src.rag.retrieval import (
    COSINE_SIMILARITY_THRESHOLD,
    MAX_CONVERSATION_MESSAGES,
    MAX_CONVERSATION_TOKENS,
    RAGResult,
    RAGRetrieval,
    RetrievedChunk,
)


# ---------------------------------------------------------------------------
# Fixtures and Mocks
# ---------------------------------------------------------------------------


class MockEmbeddingPipeline:
    """Mock embedding pipeline that returns a fixed vector."""

    def __init__(self, vector: list[float] | None = None):
        self._vector = vector or [0.1] * 1536

    async def embed_text(self, text: str, input_type: str = "search_document") -> list[float]:
        return self._vector


class MockBedrockClient:
    """Mock Bedrock client that returns configurable relevance scores."""

    def __init__(self, scores: list[str] | None = None):
        self._scores = scores or ["8"]
        self._call_index = 0

    async def invoke(self, messages, task_type, system_prompt=None, max_tokens=4096):
        score_text = self._scores[self._call_index % len(self._scores)]
        self._call_index += 1
        return LLMResponse(
            content=score_text,
            model_id="test-model",
            input_tokens=10,
            output_tokens=1,
            stop_reason="end_turn",
        )


class MockHttpClient:
    """Mock HTTP client that returns configurable search results."""

    def __init__(self, results: list[dict] | None = None):
        self._results = results or []

    async def post(self, url: str, json: dict = None, timeout: float = None):
        return MockResponse(self._results)


class MockResponse:
    """Mock HTTP response."""

    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


@pytest.fixture
def sample_search_results():
    """Sample hybrid search results from Data Gateway."""
    return [
        {
            "content": "The refund policy allows returns within 30 days.",
            "filename": "policies.pdf",
            "page_number": 5,
            "chunk_index": 2,
            "vector_score": 0.92,
            "bm25_score": 12.5,
            "source": "hybrid",
        },
        {
            "content": "Shipping takes 3-5 business days for standard delivery.",
            "filename": "shipping.pdf",
            "page_number": 1,
            "chunk_index": 0,
            "vector_score": 0.75,
            "bm25_score": 3.2,
            "source": "vector",
        },
        {
            "content": "Contact support at support@example.com for refund issues.",
            "filename": "support.pdf",
            "page_number": 2,
            "chunk_index": 1,
            "vector_score": 0.85,
            "bm25_score": 8.7,
            "source": "keyword",
        },
        {
            "content": "Our company was founded in 2010.",
            "filename": "about.pdf",
            "page_number": 1,
            "chunk_index": 0,
            "vector_score": 0.65,  # Below threshold
            "bm25_score": 1.0,
            "source": "keyword",
        },
    ]


@pytest.fixture
def rag_retrieval(sample_search_results):
    """Create a RAGRetrieval instance with mocked dependencies."""
    return RAGRetrieval(
        data_gateway_url="http://localhost:8080",
        embedding_pipeline=MockEmbeddingPipeline(),
        bedrock_client=MockBedrockClient(scores=["9", "6", "8"]),
        http_client=MockHttpClient(results=sample_search_results),
    )


# ---------------------------------------------------------------------------
# Tests: Threshold Filtering
# ---------------------------------------------------------------------------


class TestThresholdFiltering:
    """Tests for cosine similarity threshold filtering."""

    def test_filters_below_threshold(self, sample_search_results):
        """Results with vector_score < 0.7 are filtered out."""
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(results=sample_search_results),
        )
        filtered = retrieval._filter_by_threshold(sample_search_results)
        assert len(filtered) == 3
        assert all(
            r["vector_score"] >= COSINE_SIMILARITY_THRESHOLD for r in filtered
        )

    def test_keeps_results_at_threshold(self):
        """Results exactly at threshold 0.7 are kept."""
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        results = [{"vector_score": 0.7, "content": "test"}]
        filtered = retrieval._filter_by_threshold(results)
        assert len(filtered) == 1

    def test_empty_results(self):
        """Empty input returns empty output."""
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        filtered = retrieval._filter_by_threshold([])
        assert filtered == []

    def test_all_below_threshold(self):
        """All results below threshold returns empty list."""
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        results = [
            {"vector_score": 0.5, "content": "a"},
            {"vector_score": 0.69, "content": "b"},
        ]
        filtered = retrieval._filter_by_threshold(results)
        assert filtered == []


# ---------------------------------------------------------------------------
# Tests: Score Parsing
# ---------------------------------------------------------------------------


class TestScoreParsing:
    """Tests for LLM response score parsing."""

    def test_parse_integer_score(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        assert retrieval._parse_score("8") == 8.0

    def test_parse_decimal_score(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        assert retrieval._parse_score("7.5") == 7.5

    def test_parse_score_with_text(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        assert retrieval._parse_score("The score is 9 out of 10") == 9.0

    def test_parse_score_clamps_above_10(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        assert retrieval._parse_score("15") == 10.0

    def test_parse_score_no_number_returns_default(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        assert retrieval._parse_score("no number here") == 5.0

    def test_parse_score_zero(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        assert retrieval._parse_score("0") == 0.0


# ---------------------------------------------------------------------------
# Tests: Conversation History Trimming
# ---------------------------------------------------------------------------


class TestConversationHistoryTrimming:
    """Tests for conversation history management."""

    def test_keeps_last_30_messages(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        history = [{"role": "user", "content": f"msg {i}"} for i in range(50)]
        trimmed = retrieval.trim_conversation_history(history)
        assert len(trimmed) <= MAX_CONVERSATION_MESSAGES
        # Should keep the most recent messages
        assert trimmed[-1]["content"] == "msg 49"

    def test_trims_by_token_count(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        # Create messages with ~200 tokens each (well over 3000 total for 30 msgs)
        long_content = "word " * 200  # ~200 tokens
        history = [{"role": "user", "content": long_content} for _ in range(30)]
        trimmed = retrieval.trim_conversation_history(history)
        # Should have fewer than 30 messages due to token limit
        assert len(trimmed) < 30
        # Total tokens should be under the limit
        total_tokens = sum(
            retrieval._token_count(msg["content"]) for msg in trimmed
        )
        assert total_tokens <= MAX_CONVERSATION_TOKENS

    def test_empty_history(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        trimmed = retrieval.trim_conversation_history([])
        assert trimmed == []

    def test_short_history_unchanged(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        history = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]
        trimmed = retrieval.trim_conversation_history(history)
        assert trimmed == history


# ---------------------------------------------------------------------------
# Tests: Context Building
# ---------------------------------------------------------------------------


class TestContextBuilding:
    """Tests for context string formatting."""

    def test_builds_context_with_chunks_and_history(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        chunks = [
            RetrievedChunk(
                content="Refund policy content",
                filename="policies.pdf",
                page_number=5,
                chunk_index=2,
                relevance_score=0.9,
                source="hybrid",
            ),
        ]
        history = [{"role": "user", "content": "What is the refund policy?"}]

        context = retrieval.build_context(chunks, history)

        assert "=== Retrieved Documents ===" in context
        assert "[Source 1] policies.pdf" in context
        assert "page 5" in context
        assert "relevance: 0.90" in context
        assert "Refund policy content" in context
        assert "=== Conversation History ===" in context
        assert "user: What is the refund policy?" in context

    def test_builds_context_no_chunks(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        history = [{"role": "user", "content": "Hello"}]
        context = retrieval.build_context([], history)
        assert "=== Retrieved Documents ===" not in context
        assert "=== Conversation History ===" in context

    def test_builds_context_no_history(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        chunks = [
            RetrievedChunk(
                content="Some content",
                filename="doc.pdf",
                page_number=1,
                chunk_index=0,
                relevance_score=0.85,
                source="vector",
            ),
        ]
        context = retrieval.build_context(chunks, [])
        assert "=== Retrieved Documents ===" in context
        assert "=== Conversation History ===" not in context

    def test_builds_context_empty(self):
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(),
        )
        context = retrieval.build_context([], [])
        assert context == ""


# ---------------------------------------------------------------------------
# Tests: Full Retrieval Pipeline
# ---------------------------------------------------------------------------


class TestRetrievalPipeline:
    """Tests for the full retrieve() method."""

    @pytest.mark.asyncio
    async def test_retrieve_returns_top_3_chunks(self, sample_search_results):
        """Full pipeline returns at most 3 chunks after reranking."""
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(scores=["9", "6", "8"]),
            http_client=MockHttpClient(results=sample_search_results),
        )
        result = await retrieval.retrieve(
            query="refund policy",
            user_id="user123",
            conversation_history=[],
        )
        assert isinstance(result, RAGResult)
        assert len(result.chunks) <= 3
        assert result.query == "refund policy"

    @pytest.mark.asyncio
    async def test_retrieve_filters_low_similarity(self):
        """Results below cosine threshold are excluded."""
        low_score_results = [
            {
                "content": "Irrelevant content",
                "filename": "junk.pdf",
                "page_number": 1,
                "chunk_index": 0,
                "vector_score": 0.5,
                "bm25_score": 1.0,
                "source": "keyword",
            },
        ]
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(results=low_score_results),
        )
        result = await retrieval.retrieve(
            query="test query",
            user_id="user123",
        )
        assert result.chunks == []
        assert result.context == ""

    @pytest.mark.asyncio
    async def test_retrieve_chunks_sorted_by_rerank_score(self):
        """Chunks are sorted by reranking score descending."""
        results = [
            {
                "content": "Low relevance",
                "filename": "a.pdf",
                "page_number": 1,
                "chunk_index": 0,
                "vector_score": 0.8,
                "bm25_score": 5.0,
                "source": "hybrid",
            },
            {
                "content": "High relevance",
                "filename": "b.pdf",
                "page_number": 2,
                "chunk_index": 1,
                "vector_score": 0.9,
                "bm25_score": 10.0,
                "source": "hybrid",
            },
        ]
        # First result gets score 3, second gets score 9
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(scores=["3", "9"]),
            http_client=MockHttpClient(results=results),
        )
        result = await retrieval.retrieve(
            query="test",
            user_id="user123",
        )
        assert len(result.chunks) == 2
        # Higher rerank score should come first
        assert result.chunks[0].filename == "b.pdf"
        assert result.chunks[1].filename == "a.pdf"

    @pytest.mark.asyncio
    async def test_retrieve_includes_source_attribution(self, sample_search_results):
        """Chunks include filename, page number, and relevance score."""
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(scores=["9", "7", "8"]),
            http_client=MockHttpClient(results=sample_search_results),
        )
        result = await retrieval.retrieve(
            query="refund",
            user_id="user123",
        )
        for chunk in result.chunks:
            assert chunk.filename != ""
            assert chunk.page_number >= 0
            assert 0.0 <= chunk.relevance_score <= 1.0

    @pytest.mark.asyncio
    async def test_retrieve_with_conversation_history(self, sample_search_results):
        """Conversation history is included in the context."""
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(scores=["8", "7", "6"]),
            http_client=MockHttpClient(results=sample_search_results),
        )
        history = [
            {"role": "user", "content": "Tell me about refunds"},
            {"role": "assistant", "content": "Sure, let me look that up."},
        ]
        result = await retrieval.retrieve(
            query="refund policy details",
            user_id="user123",
            conversation_history=history,
        )
        assert "Tell me about refunds" in result.context
        assert "Sure, let me look that up." in result.context

    @pytest.mark.asyncio
    async def test_retrieve_empty_results(self):
        """Empty search results return empty RAGResult."""
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(),
            http_client=MockHttpClient(results=[]),
        )
        result = await retrieval.retrieve(
            query="nonexistent topic",
            user_id="user123",
        )
        assert result.chunks == []
        assert result.context == ""
        assert result.query == "nonexistent topic"


# ---------------------------------------------------------------------------
# Tests: Reranking
# ---------------------------------------------------------------------------


class TestReranking:
    """Tests for cross-encoder reranking logic."""

    @pytest.mark.asyncio
    async def test_rerank_uses_bedrock_scores(self):
        """Reranking uses Bedrock LLM scores, not original vector scores."""
        results = [
            {
                "content": "Content A",
                "filename": "a.pdf",
                "page_number": 1,
                "chunk_index": 0,
                "vector_score": 0.95,  # High vector score
                "bm25_score": 10.0,
                "source": "vector",
            },
            {
                "content": "Content B",
                "filename": "b.pdf",
                "page_number": 2,
                "chunk_index": 1,
                "vector_score": 0.75,  # Lower vector score
                "bm25_score": 5.0,
                "source": "keyword",
            },
        ]
        # Bedrock gives higher score to B (second result)
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=MockBedrockClient(scores=["4", "9"]),
            http_client=MockHttpClient(results=results),
        )
        reranked = await retrieval._rerank("test query", results)
        # B should be first because Bedrock scored it higher
        assert reranked[0].filename == "b.pdf"
        assert reranked[0].relevance_score == 0.9  # 9/10

    @pytest.mark.asyncio
    async def test_rerank_handles_bedrock_failure(self):
        """If Bedrock fails, fallback score of 0.5 is used."""

        class FailingBedrockClient:
            async def invoke(self, messages, task_type, system_prompt=None, max_tokens=4096):
                raise RuntimeError("Bedrock unavailable")

        results = [
            {
                "content": "Content",
                "filename": "doc.pdf",
                "page_number": 1,
                "chunk_index": 0,
                "vector_score": 0.8,
                "bm25_score": 5.0,
                "source": "hybrid",
            },
        ]
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=MockEmbeddingPipeline(),
            bedrock_client=FailingBedrockClient(),
            http_client=MockHttpClient(results=results),
        )
        reranked = await retrieval._rerank("test", results)
        assert len(reranked) == 1
        assert reranked[0].relevance_score == 0.5  # Fallback score
