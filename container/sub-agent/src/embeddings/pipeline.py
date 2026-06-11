"""
Embedding pipeline — Bedrock embeddings client (Titan v2 / Cohere v4) and document chunking.

Provides:
- RecursiveCharacterSplitter: splits text into token-bounded chunks with overlap
- EmbeddingPipeline: embeds text via Amazon Bedrock (Titan v2 in us-east-1, Cohere v4 in ap-southeast-1)

Requirements: REQ-3.2
"""

import asyncio
import json
import logging
import os
from typing import Any

import boto3
import tiktoken
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Default model resolution: env override > region default.
# - ap-southeast-1: only Cohere Embed v4 is available.
# - us-east-1 / others: keep Titan v2 (1024-d default but configurable to 1536).
COHERE_MODEL_ID = "cohere.embed-v4:0"
TITAN_MODEL_ID = "amazon.titan-embed-text-v2:0"


def _resolve_default_model_id() -> str:
    """Pick the right embedding model based on env / region."""
    override = os.environ.get("BEDROCK_EMBEDDING_MODEL_ID")
    if override:
        return override
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or ""
    if region == "ap-southeast-1":
        return COHERE_MODEL_ID
    return TITAN_MODEL_ID


DEFAULT_MODEL_ID = _resolve_default_model_id()
VECTOR_DIMENSION = 1024
DEFAULT_BATCH_SIZE = 50

# Retry configuration: exponential backoff 1s, 2s, 4s (3 attempts max)
# Total worst-case: 1+2+4 = 7s — fits within 45s admin-test BRPOP window
MAX_RETRIES = 3
BACKOFF_BASE_SECONDS = 1.0

# Chunking defaults
DEFAULT_CHUNK_SIZE = 512  # tokens
DEFAULT_CHUNK_OVERLAP = 50  # tokens
DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", " ", ""]

# Tiktoken encoding for token counting
ENCODING_NAME = "cl100k_base"


# ---------------------------------------------------------------------------
# RecursiveCharacterSplitter
# ---------------------------------------------------------------------------


class RecursiveCharacterSplitter:
    """
    Recursively splits text into chunks bounded by token count.

    Uses tiktoken (cl100k_base) for accurate token counting. Splits text
    using a hierarchy of separators, falling back to finer-grained splits
    when chunks exceed the token limit.

    Invariants:
    - Every chunk contains at most `chunk_size` tokens
    - Consecutive chunks overlap by approximately `chunk_overlap` tokens (±5)
    - Concatenating all chunks with overlap removal reconstructs the original text
    """

    def __init__(
        self,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
        separators: list[str] | None = None,
    ) -> None:
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.separators = separators if separators is not None else list(DEFAULT_SEPARATORS)
        self._encoding = tiktoken.get_encoding(ENCODING_NAME)

    def _token_length(self, text: str) -> int:
        """Count the number of tokens in a text string."""
        return len(self._encoding.encode(text))

    def _split_by_separator(self, text: str, separator: str) -> list[str]:
        """Split text by separator, keeping the separator at the end of each piece."""
        if separator == "":
            # Character-level split
            return list(text)
        parts = text.split(separator)
        # Re-attach separator to each part except the last
        result = []
        for i, part in enumerate(parts):
            if i < len(parts) - 1:
                result.append(part + separator)
            else:
                if part:  # Don't add empty trailing part
                    result.append(part)
        return result

    def _merge_pieces(self, pieces: list[str]) -> list[str]:
        """
        Merge small pieces into chunks that respect the token limit,
        adding overlap between consecutive chunks.

        Uses actual token counting on the joined text to ensure accurate
        overlap measurement (BPE tokenizers may merge tokens at boundaries).
        """
        chunks: list[str] = []
        current_pieces: list[str] = []
        current_tokens = 0

        for piece in pieces:
            # Check if adding this piece would exceed the chunk size
            candidate = "".join(current_pieces) + piece
            candidate_tokens = self._token_length(candidate)

            if candidate_tokens <= self.chunk_size:
                current_pieces.append(piece)
                current_tokens = candidate_tokens
            else:
                # Emit current chunk if non-empty
                if current_pieces:
                    chunks.append("".join(current_pieces))

                # Build overlap from the tail of current_pieces
                # Use actual token counting on joined text for accuracy
                overlap_pieces: list[str] = []
                for p in reversed(current_pieces):
                    candidate_overlap = [p] + overlap_pieces
                    overlap_text = "".join(candidate_overlap)
                    if self._token_length(overlap_text) <= self.chunk_overlap:
                        overlap_pieces = candidate_overlap
                    else:
                        break

                # Start new chunk with overlap + current piece
                current_pieces = overlap_pieces + [piece]
                current_tokens = self._token_length("".join(current_pieces))

        # Emit final chunk
        if current_pieces:
            chunks.append("".join(current_pieces))

        return chunks

    def _recursive_split(self, text: str, separators: list[str]) -> list[str]:
        """
        Recursively split text using the separator hierarchy.

        If splitting by the current separator produces pieces that are all
        within the token limit, merge them with overlap. Otherwise, recursively
        split oversized pieces with the next separator.
        """
        if not text:
            return []

        # If text fits in one chunk, return as-is
        if self._token_length(text) <= self.chunk_size:
            return [text]

        # Find the best separator to use
        separator = separators[-1] if separators else ""
        remaining_separators = []

        for i, sep in enumerate(separators):
            if sep == "":
                separator = sep
                remaining_separators = []
                break
            if sep in text:
                separator = sep
                remaining_separators = separators[i + 1:]
                break

        # Split by the chosen separator
        pieces = self._split_by_separator(text, separator)

        # Check if any piece exceeds the chunk size
        final_pieces: list[str] = []
        for piece in pieces:
            if self._token_length(piece) <= self.chunk_size:
                final_pieces.append(piece)
            elif remaining_separators:
                # Recursively split oversized piece with finer separator
                sub_chunks = self._recursive_split(piece, remaining_separators)
                final_pieces.extend(sub_chunks)
            else:
                # Last resort: character-level truncation to fit chunk_size
                final_pieces.extend(self._force_split(piece))

        return self._merge_pieces(final_pieces)

    def _force_split(self, text: str) -> list[str]:
        """Force-split text into token-bounded pieces at character level."""
        pieces: list[str] = []
        tokens = self._encoding.encode(text)
        i = 0
        while i < len(tokens):
            chunk_tokens = tokens[i: i + self.chunk_size]
            piece = self._encoding.decode(chunk_tokens)
            pieces.append(piece)
            i += self.chunk_size
        return pieces

    def split_text(self, text: str) -> list[str]:
        """
        Split text into chunks respecting token limits and overlap.

        Args:
            text: Input text to split.

        Returns:
            List of text chunks, each ≤ chunk_size tokens, with ~chunk_overlap
            token overlap between consecutive chunks.
        """
        if not text:
            return []

        if self._token_length(text) <= self.chunk_size:
            return [text]

        return self._recursive_split(text, self.separators)


# ---------------------------------------------------------------------------
# EmbeddingPipeline
# ---------------------------------------------------------------------------


class EmbeddingPipeline:
    """
    Amazon Bedrock Titan Embeddings client with batching and retry.

    Produces 1536-dimension vectors. Supports single text embedding,
    batch embedding (up to 50 texts per API call), and full document
    embedding (split + embed all chunks).

    Implements exponential backoff retry (1s, 2s, 4s, 8s, 16s) up to 5 retries.

    Usage:
        pipeline = EmbeddingPipeline(region="ap-southeast-1")
        vector = await pipeline.embed_text("Hello world")
        doc_chunks = await pipeline.embed_document(long_text)
    """

    def __init__(
        self,
        region: str = "ap-southeast-1",
        model_id: str | None = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
        boto_client: Any = None,
        splitter: RecursiveCharacterSplitter | None = None,
    ) -> None:
        self.region = region
        # Resolve model_id: explicit arg > env override > region default.
        if model_id is not None:
            self.model_id = model_id
        else:
            override = os.environ.get("BEDROCK_EMBEDDING_MODEL_ID")
            if override:
                self.model_id = override
            elif region == "ap-southeast-1":
                self.model_id = COHERE_MODEL_ID
            else:
                self.model_id = TITAN_MODEL_ID
        self.batch_size = batch_size

        # Allow injecting a boto3 client for testing
        if boto_client is not None:
            self._client = boto_client
        else:
            self._client = boto3.client(
                "bedrock-runtime",
                region_name=region,
            )

        self._splitter = splitter or RecursiveCharacterSplitter()

    async def _invoke_with_retry(self, body: dict[str, Any]) -> dict[str, Any]:
        """
        Call Bedrock InvokeModel with exponential backoff retry.

        Retries up to 5 times with delays: 1s, 2s, 4s, 8s, 16s.

        Args:
            body: Request body for the Titan Embeddings model.

        Returns:
            Parsed JSON response from Bedrock.

        Raises:
            ClientError: If all retries are exhausted.
        """
        last_error: Exception | None = None

        for attempt in range(MAX_RETRIES):
            try:
                loop = asyncio.get_event_loop()
                response = await loop.run_in_executor(
                    None,
                    lambda: self._client.invoke_model(
                        modelId=self.model_id,
                        contentType="application/json",
                        accept="application/json",
                        body=json.dumps(body),
                    ),
                )
                response_body = json.loads(response["body"].read())
                return response_body

            except (ClientError, Exception) as e:
                last_error = e
                logger.warning(
                    "Bedrock embedding attempt %d/%d failed: %s",
                    attempt + 1,
                    MAX_RETRIES,
                    str(e),
                )
                # ValidationException = bad request (wrong params/model) — don't retry
                if "ValidationException" in type(e).__name__ or "ValidationException" in str(e):
                    logger.error("Bedrock ValidationException — not retrying: %s", str(e))
                    raise

                if attempt < MAX_RETRIES - 1:
                    backoff = BACKOFF_BASE_SECONDS * (2**attempt)
                    logger.info("Retrying embedding in %.1fs...", backoff)
                    await asyncio.sleep(backoff)

        logger.error(
            "All %d retries exhausted for Bedrock embedding. Last error: %s",
            MAX_RETRIES,
            last_error,
        )
        raise last_error  # type: ignore[misc]

    def _build_request_body(self, text: str) -> dict[str, Any]:
        """Build the model-specific InvokeModel body."""
        mid = self.model_id.lower()
        if "cohere" in mid:
            # All cohere Bedrock models use: {texts, input_type}
            # truncate is NOT supported -- text must be <= 2048 chars
            input_t = getattr(self, "_input_type", "search_document")
            # Hard-truncate to 2048 chars to avoid ValidationException
            safe_text = text[:2048] if len(text) > 2048 else text
            body_c: dict[str, object] = {
                "texts": [safe_text],
                "input_type": input_t,
                # NOTE: cohere.embed-v4:0 on Bedrock outputs 1024 dims by default.
                # output_dimension param is NOT supported by the Bedrock API - do not add it.
            }
            return body_c
        # Default to Titan Embeddings v2 schema.
        return {
            "inputText": text,
            "dimensions": VECTOR_DIMENSION,
            "normalize": True,
        }

    def _parse_response(self, response: dict[str, Any]) -> list[float]:
        """Extract a single embedding vector from the model-specific response."""
        # Cohere: { "embeddings": [[...]] } or { "embeddings": {"float": [[...]]} }
        if "embeddings" in response:
            embs = response["embeddings"]
            if isinstance(embs, dict):
                # v4 shape with explicit dtype keys
                for key in ("float", "float32", "int8", "uint8", "binary", "ubinary"):
                    if key in embs and embs[key]:
                        return list(embs[key][0])
            if isinstance(embs, list) and embs:
                return list(embs[0])
        # Titan: { "embedding": [...] }
        if "embedding" in response:
            return list(response["embedding"])
        raise ValueError(f"Unrecognised embedding response shape: keys={list(response.keys())}")

    async def embed_text(self, text: str, input_type: str = "search_document") -> list[float]:
        """
        Embed a single text string into an embedding vector.

        Vector dimension depends on the active model:
        - Titan v2: 1536 (configurable)
        - Cohere embed-multilingual-v3: 1024 (active in prod)

        Args:
            text: Input text to embed.

        Returns:
            List of floats representing the embedding vector.
        """
        if not text or not text.strip():
            logger.warning("embed_text called with empty/blank string, returning zero vector")
            return [0.0] * VECTOR_DIMENSION
        self._input_type = input_type  # pass to _build_request_body
        body = self._build_request_body(text)
        response = await self._invoke_with_retry(body)
        return self._parse_response(response)

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """
        Embed a batch of texts, processing up to batch_size (50) per API call.

        Titan Embeddings v2 processes one text per invoke call, so this method
        makes concurrent calls within each batch of 50 for efficiency.

        Args:
            texts: List of text strings to embed.

        Returns:
            List of embedding vectors (each 1536 floats), in the same order as input.
        """
        all_embeddings: list[list[float]] = []

        # Process in batches of batch_size
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i: i + self.batch_size]

            # Run all embeddings in the batch concurrently
            tasks = [self.embed_text(text) for text in batch]
            batch_embeddings = await asyncio.gather(*tasks)
            all_embeddings.extend(batch_embeddings)

        return all_embeddings

    async def embed_document(self, text: str) -> list[tuple[str, list[float]]]:
        """
        Split a document into chunks and embed all chunks.

        Uses RecursiveCharacterSplitter to split text into 512-token chunks
        with 50-token overlap, then embeds all chunks.

        Args:
            text: Full document text to process.

        Returns:
            List of (chunk_text, embedding_vector) tuples.
        """
        chunks = self._splitter.split_text(text)

        if not chunks:
            return []

        embeddings = await self.embed_batch(chunks)

        return list(zip(chunks, embeddings))
