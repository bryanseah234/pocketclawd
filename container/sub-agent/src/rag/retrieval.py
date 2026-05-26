"""
RAG retrieval pipeline — hybrid search with cross-encoder reranking.

Implements:
- Hybrid retrieval: 70% vector similarity (cosine, threshold 0.7) + 30% BM25 keyword
- Cross-encoder reranking via Bedrock LLM scoring
- Top 3 chunk selection with source attribution
- 30-message conversation history management (up to 3000 tokens)

Requirements: REQ-3.3
"""

import logging
import re
from typing import Any

import tiktoken
from pydantic import BaseModel

from src.embeddings.pipeline import EmbeddingPipeline
from src.llm.bedrock_client import BedrockClient, TaskType

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

COSINE_SIMILARITY_THRESHOLD = 0.7
VECTOR_WEIGHT = 0.7
BM25_WEIGHT = 0.3
TOP_K_RESULTS = 3
MAX_CONVERSATION_MESSAGES = 30
MAX_CONVERSATION_TOKENS = 3000
ENCODING_NAME = "cl100k_base"


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class RetrievedChunk(BaseModel):
    """A single retrieved document chunk with source attribution."""

    content: str
    filename: str
    page_number: int
    chunk_index: int
    relevance_score: float
    source: str  # 'vector', 'keyword', or 'hybrid'


class RAGResult(BaseModel):
    """Result of a RAG retrieval operation."""

    chunks: list[RetrievedChunk]
    context: str  # Formatted context for LLM
    query: str


# ---------------------------------------------------------------------------
# RAG Retrieval Pipeline
# ---------------------------------------------------------------------------


class RAGRetrieval:
    """
    Hybrid RAG retrieval pipeline with cross-encoder reranking.

    Combines vector similarity search (70% weight) with BM25 keyword search
    (30% weight), applies cross-encoder reranking via Bedrock, and returns
    the top 3 most relevant chunks with source attribution.

    Usage:
        retrieval = RAGRetrieval(
            data_gateway_url="http://localhost:8080",
            embedding_pipeline=embedding_pipeline,
            bedrock_client=bedrock_client,
        )
        result = await retrieval.retrieve(
            query="What is the refund policy?",
            user_id="user123",
            conversation_history=[...],
        )
    """

    def __init__(
        self,
        data_gateway_url: str,
        embedding_pipeline: EmbeddingPipeline,
        bedrock_client: BedrockClient,
        http_client: Any = None,
    ) -> None:
        """
        Initialize the RAG retrieval pipeline.

        Args:
            data_gateway_url: URL of the Data Gateway service for hybrid search.
            embedding_pipeline: EmbeddingPipeline instance for query embedding.
            bedrock_client: BedrockClient instance for cross-encoder reranking.
            http_client: Optional HTTP client for testing (must support async get/post).
        """
        self.data_gateway_url = data_gateway_url.rstrip("/")
        self.embedding_pipeline = embedding_pipeline
        self.bedrock_client = bedrock_client
        self._http_client = http_client
        self._encoding = tiktoken.get_encoding(ENCODING_NAME)

    def _token_count(self, text: str) -> int:
        """Count tokens in a text string using cl100k_base encoding."""
        return len(self._encoding.encode(text))

    async def retrieve(
        self,
        query: str,
        user_id: str,
        conversation_history: list[dict[str, str]] | None = None,
    ) -> RAGResult:
        """
        Execute the full RAG retrieval pipeline.

        Steps:
        1. Embed the query using EmbeddingPipeline
        2. Call Data Gateway hybridSearch with query text and vector
        3. Filter results below cosine similarity threshold 0.7
        4. Apply cross-encoder reranking via Bedrock
        5. Return top 3 chunks with source attribution

        Args:
            query: The user's search query.
            user_id: User identifier for data isolation.
            conversation_history: Optional list of conversation messages.

        Returns:
            RAGResult with top chunks, formatted context, and query.
        """
        if conversation_history is None:
            conversation_history = []

        # Step 1: Embed the query
        query_vector = await self.embedding_pipeline.embed_text(query)

        # Step 2: Call hybrid search
        raw_results = await self._hybrid_search(query, query_vector, user_id)

        # Step 3: Filter by cosine similarity threshold
        filtered_results = self._filter_by_threshold(raw_results)

        if not filtered_results:
            return RAGResult(chunks=[], context="", query=query)

        # Step 4: Cross-encoder reranking
        reranked_chunks = await self._rerank(query, filtered_results)

        # Step 5: Take top 3
        top_chunks = reranked_chunks[:TOP_K_RESULTS]

        # Build context string
        trimmed_history = self.trim_conversation_history(conversation_history)
        context = self.build_context(top_chunks, trimmed_history)

        return RAGResult(chunks=top_chunks, context=context, query=query)

    async def _hybrid_search(
        self,
        query: str,
        query_vector: list[float],
        user_id: str,
    ) -> list[dict[str, Any]]:
        """
        Call the Data Gateway's hybridSearch endpoint.

        Args:
            query: Text query for BM25 matching.
            query_vector: Embedding vector for similarity search.
            user_id: User ID for data isolation.

        Returns:
            List of raw search result dicts from the Data Gateway.
        """
        if self._http_client is not None:
            # Use injected HTTP client (for testing or direct calls)
            response = await self._http_client.post(
                f"{self.data_gateway_url}/search/hybrid",
                json={
                    "userId": user_id,
                    "query": query,
                    "vector": query_vector,
                    "topK": 20,  # Fetch more candidates for reranking
                },
            )
            return response.json() if hasattr(response, "json") else response
        else:
            # In production, use httpx
            import httpx

            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.data_gateway_url}/search/hybrid",
                    json={
                        "userId": user_id,
                        "query": query,
                        "vector": query_vector,
                        "topK": 20,
                    },
                    timeout=30.0,
                )
                response.raise_for_status()
                return response.json()

    def _filter_by_threshold(
        self, results: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """
        Filter search results below the cosine similarity threshold.

        Only results with vector_score >= 0.7 pass through.

        Args:
            results: Raw search results from hybrid search.

        Returns:
            Filtered list of results meeting the threshold.
        """
        filtered = []
        for result in results:
            vector_score = result.get("vector_score", 0.0)
            if vector_score >= COSINE_SIMILARITY_THRESHOLD:
                filtered.append(result)
        return filtered

    def _compute_combined_score(self, result: dict[str, Any], max_bm25: float) -> float:
        """
        Compute the combined hybrid score for a single result.

        Combined score = 0.7 × vector_score + 0.3 × normalized_bm25_score

        BM25 scores are normalized by dividing by the maximum BM25 score
        in the result set (min-max normalization to [0, 1]).

        Args:
            result: A search result dict with vector_score and bm25_score.
            max_bm25: Maximum BM25 score in the result set for normalization.

        Returns:
            Combined hybrid score.
        """
        vector_score = result.get("vector_score", 0.0)
        bm25_score = result.get("bm25_score", 0.0)

        # Normalize BM25 score to [0, 1]
        normalized_bm25 = bm25_score / max_bm25 if max_bm25 > 0 else 0.0

        return VECTOR_WEIGHT * vector_score + BM25_WEIGHT * normalized_bm25

    async def _rerank(
        self, query: str, results: list[dict[str, Any]]
    ) -> list[RetrievedChunk]:
        """
        Apply cross-encoder reranking using Bedrock LLM scoring.

        For each candidate chunk, asks the LLM to rate relevance on a 0-10 scale.
        Uses TaskType.RAG_QA (temperature 0.2) for consistent scoring.

        Args:
            query: The original user query.
            results: Filtered search results to rerank.

        Returns:
            List of RetrievedChunk sorted by reranking score descending.
        """
        scored_chunks: list[tuple[float, RetrievedChunk]] = []

        for result in results:
            content = result.get("content", "")
            filename = result.get("filename", "unknown")
            page_number = result.get("page_number", result.get("pageNumber", 0))
            chunk_index = result.get("chunk_index", result.get("chunkIndex", 0))
            source = result.get("source", "hybrid")

            # Score relevance using Bedrock
            rerank_score = await self._score_relevance(query, content)

            chunk = RetrievedChunk(
                content=content,
                filename=filename,
                page_number=page_number,
                chunk_index=chunk_index,
                relevance_score=rerank_score,
                source=source,
            )
            scored_chunks.append((rerank_score, chunk))

        # Sort by reranking score descending
        scored_chunks.sort(key=lambda x: x[0], reverse=True)

        return [chunk for _, chunk in scored_chunks]

    async def _score_relevance(self, query: str, passage: str) -> float:
        """
        Score the relevance of a passage to a query using Bedrock.

        Prompts the LLM to rate relevance on a 0-10 scale, then normalizes
        to [0, 1] by dividing by 10.

        Args:
            query: The user's search query.
            passage: The document passage to score.

        Returns:
            Relevance score in [0, 1].
        """
        scoring_prompt = (
            "Rate the relevance of this passage to the query on a scale of 0-10. "
            "Only respond with a single number.\n\n"
            f"Query: {query}\n\n"
            f"Passage: {passage}\n\n"
            "Score:"
        )

        try:
            response = await self.bedrock_client.invoke(
                messages=[{"role": "user", "content": scoring_prompt}],
                task_type=TaskType.RAG_QA,
                max_tokens=10,
            )

            # Parse numeric score from response
            score = self._parse_score(response.content)
            return score / 10.0  # Normalize to [0, 1]

        except Exception as e:
            logger.warning("Failed to score relevance via Bedrock: %s", str(e))
            # Fall back to combined score if reranking fails
            return 0.5

    def _parse_score(self, response_text: str) -> float:
        """
        Parse a numeric score from the LLM response text.

        Extracts the first number found in the response. Falls back to 5.0
        if no valid number is found.

        Args:
            response_text: Raw text response from the LLM.

        Returns:
            Parsed score clamped to [0, 10].
        """
        # Extract first number (integer or decimal) from response
        match = re.search(r"(\d+(?:\.\d+)?)", response_text.strip())
        if match:
            score = float(match.group(1))
            # Clamp to [0, 10]
            return max(0.0, min(10.0, score))
        return 5.0  # Default middle score if parsing fails

    def trim_conversation_history(
        self, conversation_history: list[dict[str, str]]
    ) -> list[dict[str, str]]:
        """
        Trim conversation history to last 30 messages or 3000 tokens.

        Keeps the most recent messages, removing oldest first until both
        constraints are satisfied.

        Args:
            conversation_history: Full conversation history.

        Returns:
            Trimmed conversation history.
        """
        # First, limit to last 30 messages
        trimmed = conversation_history[-MAX_CONVERSATION_MESSAGES:]

        # Then, trim by token count (remove oldest until under 3000 tokens)
        while trimmed:
            total_tokens = sum(
                self._token_count(msg.get("content", "")) for msg in trimmed
            )
            if total_tokens <= MAX_CONVERSATION_TOKENS:
                break
            # Remove the oldest message
            trimmed = trimmed[1:]

        return trimmed

    def build_context(
        self,
        chunks: list[RetrievedChunk],
        conversation_history: list[dict[str, str]],
    ) -> str:
        """
        Format retrieved chunks and conversation history as context for the LLM.

        Includes source attribution (filename, page number, relevance score)
        for each chunk, followed by trimmed conversation history.

        Args:
            chunks: Top retrieved chunks after reranking.
            conversation_history: Trimmed conversation history.

        Returns:
            Formatted context string ready for LLM consumption.
        """
        parts: list[str] = []

        # Format retrieved documents
        if chunks:
            parts.append("=== Retrieved Documents ===")
            for i, chunk in enumerate(chunks, 1):
                parts.append(
                    f"\n[Source {i}] {chunk.filename} "
                    f"(page {chunk.page_number}, relevance: {chunk.relevance_score:.2f})"
                )
                parts.append(chunk.content)

        # Format conversation history
        if conversation_history:
            parts.append("\n=== Conversation History ===")
            for msg in conversation_history:
                role = msg.get("role", "user")
                content = msg.get("content", "")
                parts.append(f"\n{role}: {content}")

        return "\n".join(parts)
