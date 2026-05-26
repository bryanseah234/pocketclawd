"""
RAG Pipeline — embed query → hybrid search → format context → LLM → respond.

Orchestrates the full retrieval-augmented generation flow:
1. Embed the user's query using Bedrock Titan
2. Send hybrid search request to orchestrator DataGateway (via Redis)
3. Format retrieved chunks as context
4. Call Bedrock Claude with history + context + query
5. Return response with source citations

Requirements: REQ-8.2
"""

import asyncio
import json
import logging
import secrets
from typing import Any

import redis.asyncio as aioredis

from src.embeddings.pipeline import EmbeddingPipeline
from src.llm.client import BedrockLLMClient, format_rag_context, format_chat_history

logger = logging.getLogger(__name__)

# Search configuration
TOP_K = 3  # Number of chunks to retrieve
SIMILARITY_THRESHOLD = 0.7  # Minimum relevance score


class RAGPipeline:
    """
    Full RAG pipeline: query → embed → search → context → LLM → response.

    Usage:
        pipeline = RAGPipeline(redis_client, user_id, region="ap-southeast-1")
        response = await pipeline.query("What was Q3 revenue?", chat_history)
    """

    def __init__(
        self,
        redis_client: aioredis.Redis,
        user_id: str,
        region: str = "ap-southeast-1",
        llm_model_id: str | None = None,
    ) -> None:
        self._redis = redis_client
        self._user_id = user_id
        self._embedding_pipeline = EmbeddingPipeline(region=region)
        self._llm = BedrockLLMClient(
            region=region,
            model_id=llm_model_id or "anthropic.claude-3-5-sonnet-20241022-v2:0",
        )

    async def query(
        self,
        user_message: str,
        chat_history: list[dict[str, Any]] | None = None,
        temperature: float = 0.5,
    ) -> str:
        """
        Execute the full RAG pipeline for a user query.

        Args:
            user_message: The user's question/message.
            chat_history: Previous messages for context (from DynamoDB).
            temperature: LLM temperature (0.2 for factual, 0.5 for balanced).

        Returns:
            The AI assistant's response text.
        """
        # Step 1: Embed the query
        query_vector = await self._embedding_pipeline.embed_text(user_message)

        # Step 2: Hybrid search via DataGateway (through Redis)
        search_results = await self._search_documents(user_message, query_vector)

        # Step 3: Format RAG context from results
        rag_context = ""
        if search_results:
            # Filter by similarity threshold
            relevant = [r for r in search_results if r.get("score", 0) >= SIMILARITY_THRESHOLD]
            if relevant:
                rag_context = format_rag_context(relevant)
                # Use lower temperature when we have document context
                temperature = 0.2

        # Step 4: Build messages for LLM
        messages = format_chat_history(chat_history or [])
        messages.append({"role": "user", "content": user_message})

        # Step 5: Call LLM with context
        response = await self._llm.chat(
            messages=messages,
            rag_context=rag_context if rag_context else None,
            temperature=temperature,
        )

        return response

    async def _search_documents(
        self, query_text: str, query_vector: list[float]
    ) -> list[dict[str, Any]]:
        """
        Send a hybrid search request to the orchestrator's DataGateway via Redis.

        The DataGateway worker on the orchestrator side executes the actual
        OpenSearch query with userId isolation.
        """
        request_id = secrets.token_hex(8)

        request = {
            "action": "hybrid_search",
            "request_id": request_id,
            "user_id": self._user_id,
            "query": query_text,
            "vector": query_vector,
            "top_k": TOP_K,
        }

        await self._redis.lpush(
            "queue:orchestrator:data_gateway",
            json.dumps(request),
        )

        # Wait for search results (with timeout)
        response_key = f"queue:agent:{self._user_id}:dg_response:{request_id}"
        result = await self._redis.brpop(response_key, timeout=10)

        if result is None:
            logger.warning("RAG search timed out for user_id=%s", self._user_id)
            return []

        _key, raw_response = result
        response = json.loads(raw_response)

        if not response.get("success", False):
            logger.warning("RAG search failed: %s", response.get("error"))
            return []

        return response.get("results", [])

    async def chat_only(
        self,
        user_message: str,
        chat_history: list[dict[str, Any]] | None = None,
    ) -> str:
        """
        Chat without RAG (no document search). Used when the user's message
        doesn't seem to be a document query.

        Args:
            user_message: The user's message.
            chat_history: Previous messages for context.

        Returns:
            The AI assistant's response text.
        """
        messages = format_chat_history(chat_history or [])
        messages.append({"role": "user", "content": user_message})

        return await self._llm.chat(
            messages=messages,
            temperature=0.5,
        )
