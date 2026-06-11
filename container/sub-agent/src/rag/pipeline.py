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
MIN_SIMILARITY_THRESHOLD = 0.73


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
        user_profile: dict | None = None,
        image_bytes_list: list[tuple[bytes, str]] | None = None,
    ) -> str:
        """
        Execute the full RAG pipeline with parallel embed+search.
        Embed and search run in parallel where possible to minimise latency.
        """
        import time as _time
        hist = history or chat_history

        # Check no-docs cache before paying for embed
        no_docs_key = f"cache:no_docs:{self._user_id}"
        _skip_rag = bool(await self._redis.exists(no_docs_key))

        if _skip_rag:
            query_vector = []
            search_results: list[dict] = []
            logger.info("PERF rag=skipped (no docs cached)")
        else:
            # Embed then search
            _te = _time.monotonic()
            query_vector = await self._embedding.embed_text(user_message, input_type="search_query")
            logger.info("PERF embed=%.2fs", _time.monotonic() - _te)

            _ts = _time.monotonic()
            search_results = await self._search(user_message, query_vector)
            logger.info("PERF search=%.2fs hits=%d", _time.monotonic() - _ts, len(search_results))

        # Step 3: Format context
        rag_context = self._format_context(search_results)

        # Step 4: LLM call
        _tl = _time.monotonic()
        response, tools_used = await self._llm.generate(
            user_message=user_message,
            history=hist,
            rag_context=rag_context if search_results else None,
            temperature=0.2 if search_results else 0.5,
            user_profile=user_profile,
            image_bytes_list=image_bytes_list,
        )
        logger.info("PERF llm=%.2fs tools=%s", _time.monotonic() - _tl, tools_used)
        response = self._append_provenance(response, search_results, tools_used)
        return response

    async def _search(
        self, query_text: str, query_vector: list[float], top_k: int = 5
    ) -> list[dict[str, Any]]:
        """
        Send a hybrid search request to the orchestrator DataGateway worker.
        Uses a 3s timeout (was 15s) and caches empty-index state per user.
        """
        # Short-circuit: if we already know this user has no indexed docs,
        # skip the network round-trip entirely (saves ~1s per message)
        no_docs_key = f"cache:no_docs:{self._user_id}"
        if await self._redis.exists(no_docs_key):
            return []

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

        # Wait for response — 3s max (was 15s)
        response_key = f"queue:agent:{self._user_id}:dg_response:{request_id}"
        result = await self._redis.brpop(response_key, timeout=3)

        if result is None:
            logger.warning("RAG search timed out for user_id=%s", self._user_id)
            return []

        _key, raw_response = result
        response = json.loads(raw_response)

        if not response.get("success", False):
            logger.warning("RAG search failed: %s", response.get("error"))
            return []

        results = response.get("results", [])
        filtered = [r for r in results if r.get("score", 0) >= MIN_SIMILARITY_THRESHOLD]

        # Cache "no docs" ONLY when the user genuinely has nothing indexed (raw
        # results empty). Caching on `not filtered` (below-threshold) would poison
        # the cache: a single low-scoring query would make the next 5 min skip RAG
        # entirely even though the user HAS docs. So we only set the no-docs cache
        # when the index returned zero raw hits.
        #
        # If we got raw hits but NONE clear MIN_SIMILARITY_THRESHOLD, we return []
        # rather than falling back to top-K. Grounding the answer (and stamping a
        # "your documents" provenance footer) on a 0.5-relevance chunk produces
        # false citations and lets irrelevant PDFs leak into unrelated answers.
        # Below-threshold means "not relevant enough to ground on" — treat as miss.
        if not results:
            await self._redis.setex(no_docs_key, 300, "1")
            return []

        if not filtered:
            logger.info(
                "RAG below-threshold miss: %d raw hits, top score=%.3f (< %.2f); "
                "not grounding (no fallback)",
                len(results),
                max((r.get("score", 0) for r in results), default=0.0),
                MIN_SIMILARITY_THRESHOLD,
            )
            return []

        return filtered

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

    _TOOL_PROVENANCE = {
        "web_search": ("\U0001F310", "web"),
        "fetch_url": ("\U0001F310", "web"),
        "get_news": ("\U0001F4F0", "news"),
        "get_weather": ("\U0001F326", "live weather"),
        "get_sg_weather": ("\U0001F326", "live weather"),
        "get_sg_psi": ("\U0001F326", "live weather"),
        "get_crypto_price": ("\U0001F4C8", "live market data"),
        "get_stock_price": ("\U0001F4C8", "live market data"),
        "convert_currency": ("\U0001F4B1", "live FX"),
        "search_wikipedia": ("\U0001F4DA", "Wikipedia"),
        "search_arxiv": ("\U0001F4DA", "arXiv"),
    }
    _MEDIA_TOOLS = {"generate_image", "generate_document"}

    def _append_provenance(self, text, search_results, tools_used):
        if not text:
            return text
        if any(t in self._MEDIA_TOOLS for t in tools_used) or "IMAGE_URL:" in text or "DOC_URL:" in text:
            return text
        parts = []
        # Document provenance: only when retrieval actually grounded the answer.
        # `search_results` here is post-threshold (>= MIN_SIMILARITY_THRESHOLD) and
        # non-empty only when relevant chunks were injected into the prompt. We do
        # NOT attest "your documents" on a below-threshold miss (search returns []).
        if search_results:
            seen = []
            for r in search_results:
                fn = r.get("filename") or "your document"
                if fn not in seen:
                    seen.append(fn)
            doc_names = ", ".join(seen[:3])
            extra = "" if len(seen) <= 3 else " +%d more" % (len(seen) - 3)
            parts.append("\U0001F4C4 your documents (%s%s)" % (doc_names, extra))
        # Tool provenance: only when a real (non-media) tool actually ran this turn.
        seen_labels = []
        for t in tools_used:
            if t in self._MEDIA_TOOLS:
                continue
            emoji, label = self._TOOL_PROVENANCE.get(t, ("\U0001F527", t.replace("_", " ")))
            tag = "%s %s" % (emoji, label)
            if tag not in seen_labels:
                seen_labels.append(tag)
        parts.extend(seen_labels)
        # Strip any model-emitted "Source:" line (the model is told to cite in prose
        # only; a structured footer is owned deterministically by code, not the LLM).
        import re as _re
        text = _re.sub(r"\n+_?Sources?:.*$", "", text.rstrip(), flags=_re.IGNORECASE | _re.DOTALL).rstrip()
        # If nothing genuinely grounded the answer (no docs, no tools), append NO
        # footer. We never claim "general knowledge" — an un-footered reply is the
        # truthful signal that the answer came from the model itself.
        if not parts:
            return text
        return text + "\n\n_Source: " + " \u00b7 ".join(parts) + "_"

