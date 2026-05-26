"""
RAG Pipeline — embed query → search → format context → LLM response.

Orchestrates the full retrieval-augmented generation flow:
1. Embed the user's query using Bedrock Titan
2. Send hybrid search request to orchestrator DataGateway (via Redis)
3. Format retrieved chunks as context with source attribution
4. Call Bedrock Claude with context + conversation history
5. Return the response

Requirements: REQ-8.2
"""

import asyncio
import json
import logging
import secrets
from typing import Any

import redis.asyncio as aioredis

from src.embeddings.pipeline import EmbeddingPipeline
from src.llm.client import BedrockClaude

logger = logging.getLogger(__name__)

# Minimum similarity threshold (PRD §4.2.3)
MIN_SIMILARITY_THRESHOLD = 0.7


class RAGPipeline:
    """
    Full RAG pipeline: query → embed → search → context → LLM → response.

    The search step communicates with the orchestrator's DataGateway via Redis
    because sub-agents cannot access OpenSearch directly.
    """

    def __init__(
        self,
        redis_client: aioredis.Redis,
        user_id: str,
        embedding_pipeline: EmbeddingPipeline | None = None,
        llm_client: BedrockClaude | None = None,
        region: str = "ap-southeast-1",
    ) -> None:
        self._redis = redis_client
        self._user_id = user_id
        self._embedding = embedding_pipeline or EmbeddingPipeline(region=region)
        self._llm = llm_client or BedrockClaude(region=region)

    async def query(
        self,
        user_message: str,
        history: list[dict[str, str]] | None = None,
        chat_history: list[dict[str, str]] | None = None,
    ) -> str:
        """
        Execute the full RAG pipeline.

        Args:
            user_message: The user's question/message.
            history: Conversation history for context (alias: chat_history).

        Returns:
            The AI-generated response with source citations.
        """
        hist = history or chat_history
        # Step 1: Embed the query
        query_vector = await self._embedding.embed_text(user_message)

        # Step 2: Search via DataGateway (orchestrator-side)
        search_results = await self._search(user_message, query_vector)

        # Step 3: Format context from search results
        rag_context = self._format_context(search_results)

        # Step 4: Generate response with LLM
        response = await self._llm.generate(
            user_message=user_message,
            history=hist,
            rag_context=rag_context if search_results else None,
            temperature=0.2 if search_results else 0.5,  # Lower temp for RAG
        )

        return response

    async def _search(
        self, query_text: str, query_vector: list[float], top_k: int = 5
    ) -> list[dict[str, Any]]:
        """
        Send a hybrid search request to the orchestrator's DataGateway worker.

        The DataGateway worker executes the actual OpenSearch query with
        userId isolation enforcement.
        """
        request_id = secrets.token_hex(8)
        request = {
            "action": "hybrid_search",
            "request_id": request_id,
            "user_id": self._user_id,
            "query": query_text,
            "vector": query_vector,
            "top_k": top_k,
        }

        await self._redis.lpush(
            "queue:orchestrator:data_gateway",
            json.dumps(request),
        )

        # Wait for response
        response_key = f"queue:agent:{self._user_id}:dg_response:{request_id}"
        result = await self._redis.brpop(response_key, timeout=15)

        if result is None:
            logger.warning("RAG search timed out for user_id=%s", self._user_id)
            return []

        _key, raw_response = result
        response = json.loads(raw_response)

        if not response.get("success", False):
            logger.warning("RAG search failed: %s", response.get("error"))
            return []

        results = response.get("results", [])

        # Filter by minimum similarity threshold
        return [r for r in results if r.get("score", 0) >= MIN_SIMILARITY_THRESHOLD]

    def _format_context(self, results: list[dict[str, Any]]) -> str:
        """
        Format search results as context for the LLM.

        Each chunk includes source attribution (filename, page number, score).
        """
        if not results:
            return ""

        context_parts: list[str] = []
        for i, result in enumerate(results[:3], 1):  # Top 3 only
            filename = result.get("filename", "unknown")
            page = result.get("pageNumber", 0)
            content = result.get("content", "")
            score = result.get("score", 0)

            header = f"[Source {i}: {filename}"
            if page > 0:
                header += f", page {page}"
            header += f" (relevance: {score:.2f})]"

            context_parts.append(f"{header}\n{content}")

        return "\n\n---\n\n".join(context_parts)
