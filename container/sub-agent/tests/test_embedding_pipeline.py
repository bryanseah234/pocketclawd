"""
Unit tests for the embedding pipeline.

Tests RecursiveCharacterSplitter chunking logic and EmbeddingPipeline
integration with mocked Bedrock client.
"""

import asyncio
import io
import json
from unittest.mock import MagicMock, patch

import pytest
import tiktoken

from src.embeddings.pipeline import (
    DEFAULT_CHUNK_OVERLAP,
    DEFAULT_CHUNK_SIZE,
    ENCODING_NAME,
    VECTOR_DIMENSION,
    EmbeddingPipeline,
    RecursiveCharacterSplitter,
)


# ---------------------------------------------------------------------------
# RecursiveCharacterSplitter Tests
# ---------------------------------------------------------------------------


class TestRecursiveCharacterSplitter:
    """Tests for the RecursiveCharacterSplitter class."""

    def setup_method(self):
        self.splitter = RecursiveCharacterSplitter()
        self.encoding = tiktoken.get_encoding(ENCODING_NAME)

    def _token_count(self, text: str) -> int:
        return len(self.encoding.encode(text))

    def test_empty_text_returns_empty_list(self):
        assert self.splitter.split_text("") == []

    def test_short_text_returns_single_chunk(self):
        text = "Hello, world!"
        chunks = self.splitter.split_text(text)
        assert len(chunks) == 1
        assert chunks[0] == text

    def test_text_at_exactly_chunk_size_returns_single_chunk(self):
        # Generate text that is exactly 512 tokens
        # Use repeated simple words to get predictable token counts
        words = "hello " * 512
        # Trim to exactly 512 tokens
        tokens = self.encoding.encode(words)[:512]
        text = self.encoding.decode(tokens)

        chunks = self.splitter.split_text(text)
        assert len(chunks) == 1
        assert self._token_count(chunks[0]) <= DEFAULT_CHUNK_SIZE

    def test_chunks_do_not_exceed_max_tokens(self):
        # Create a long text that requires multiple chunks
        text = "This is a sentence with some content. " * 200
        chunks = self.splitter.split_text(text)

        assert len(chunks) > 1
        for chunk in chunks:
            token_count = self._token_count(chunk)
            assert token_count <= DEFAULT_CHUNK_SIZE, (
                f"Chunk has {token_count} tokens, exceeds limit of {DEFAULT_CHUNK_SIZE}"
            )

    def test_consecutive_chunks_have_overlap(self):
        # Create text long enough for multiple chunks with unique content
        words = [f"word{i}" for i in range(2000)]
        text = " ".join(words)
        chunks = self.splitter.split_text(text)

        assert len(chunks) >= 2

        for i in range(len(chunks) - 1):
            current = chunks[i]
            next_chunk = chunks[i + 1]

            # Find the text overlap: longest suffix of current that is a prefix of next
            overlap_text = ""
            for length in range(1, min(len(current), len(next_chunk)) + 1):
                if current.endswith(next_chunk[:length]):
                    overlap_text = next_chunk[:length]

            overlap_tokens = self._token_count(overlap_text) if overlap_text else 0

            # Overlap should be approximately chunk_overlap (±5 tolerance)
            assert overlap_tokens >= DEFAULT_CHUNK_OVERLAP - 5, (
                f"Overlap between chunk {i} and {i+1} is {overlap_tokens} tokens, "
                f"expected ~{DEFAULT_CHUNK_OVERLAP} (±5)"
            )

    def test_splits_on_paragraph_boundaries(self):
        text = "First paragraph content here.\n\nSecond paragraph content here.\n\nThird paragraph."
        chunks = self.splitter.split_text(text)
        # Short text should be a single chunk
        assert len(chunks) == 1
        assert chunks[0] == text

    def test_splits_long_text_on_paragraph_boundaries(self):
        # Create paragraphs that together exceed chunk size
        paragraph = "This is a paragraph with enough content to take up space. " * 30
        text = f"{paragraph}\n\n{paragraph}\n\n{paragraph}"
        chunks = self.splitter.split_text(text)

        assert len(chunks) > 1
        for chunk in chunks:
            assert self._token_count(chunk) <= DEFAULT_CHUNK_SIZE

    def test_custom_chunk_size_and_overlap(self):
        splitter = RecursiveCharacterSplitter(chunk_size=100, chunk_overlap=10)
        text = "Word " * 500  # ~500 tokens
        chunks = splitter.split_text(text)

        assert len(chunks) > 1
        for chunk in chunks:
            assert self._token_count(chunk) <= 100

    def test_handles_text_without_separators(self):
        # Text with no standard separators — use diverse characters to avoid
        # BPE compression (repeated patterns compress to very few tokens)
        # Use random-looking unique sequences to maximize token count
        import hashlib
        # Generate text by hashing sequential numbers — produces high-entropy strings
        text = "".join(hashlib.md5(str(i).encode()).hexdigest() for i in range(500))
        # Verify it actually exceeds chunk size
        assert self._token_count(text) > DEFAULT_CHUNK_SIZE

        chunks = self.splitter.split_text(text)

        assert len(chunks) > 1
        for chunk in chunks:
            assert self._token_count(chunk) <= DEFAULT_CHUNK_SIZE


# ---------------------------------------------------------------------------
# EmbeddingPipeline Tests
# ---------------------------------------------------------------------------


def _make_mock_bedrock_response(dimension: int = VECTOR_DIMENSION) -> dict:
    """Create a mock Bedrock Cohere Embed response (default in apse1)."""
    return {
        "embeddings": [[0.1] * dimension],
        "id": "test",
    }


def _make_mock_client():
    """Create a mock boto3 bedrock-runtime client."""
    mock_client = MagicMock()

    def invoke_model(**kwargs):
        response_body = json.dumps(_make_mock_bedrock_response()).encode()
        return {
            "body": io.BytesIO(response_body),
        }

    mock_client.invoke_model = MagicMock(side_effect=invoke_model)
    return mock_client


class TestEmbeddingPipeline:
    """Tests for the EmbeddingPipeline class."""

    def setup_method(self):
        self.mock_client = _make_mock_client()
        self.pipeline = EmbeddingPipeline(
            region="ap-southeast-1",
            boto_client=self.mock_client,
        )

    @pytest.mark.asyncio
    async def test_embed_text_returns_correct_dimension(self):
        result = await self.pipeline.embed_text("Hello world")
        assert len(result) == VECTOR_DIMENSION
        assert all(isinstance(v, float) for v in result)

    @pytest.mark.asyncio
    async def test_embed_text_calls_bedrock_with_correct_params(self):
        await self.pipeline.embed_text("Test input")

        self.mock_client.invoke_model.assert_called_once()
        call_kwargs = self.mock_client.invoke_model.call_args[1]
        # Default in ap-southeast-1 is Cohere Embed v4.
        assert call_kwargs["modelId"] == "cohere.embed-v4:0"
        assert call_kwargs["contentType"] == "application/json"

        body = json.loads(call_kwargs["body"])
        assert body["texts"] == ["Test input"]
        assert body["input_type"] == "search_document"
        # Cohere on Bedrock rejects a `truncate` param (ValidationException); the
        # pipeline hard-truncates text to 2048 chars instead, so no truncate key.
        assert "truncate" not in body

    @pytest.mark.asyncio
    async def test_embed_text_titan_in_other_region(self):
        """Explicit Titan model id should send Titan-shaped body."""
        # Override mock to return Titan-shaped response.
        titan_client = MagicMock()

        def invoke_titan(**kwargs):
            body = json.dumps({"embedding": [0.2] * VECTOR_DIMENSION, "inputTextTokenCount": 5}).encode()
            return {"body": io.BytesIO(body)}

        titan_client.invoke_model = MagicMock(side_effect=invoke_titan)
        pipeline = EmbeddingPipeline(
            region="us-east-1",
            model_id="amazon.titan-embed-text-v2:0",
            boto_client=titan_client,
        )
        result = await pipeline.embed_text("Test input")
        assert len(result) == VECTOR_DIMENSION
        call_kwargs = titan_client.invoke_model.call_args[1]
        assert call_kwargs["modelId"] == "amazon.titan-embed-text-v2:0"
        body = json.loads(call_kwargs["body"])
        assert body["inputText"] == "Test input"
        assert body["dimensions"] == VECTOR_DIMENSION
        assert body["normalize"] is True

    @pytest.mark.asyncio
    async def test_embed_batch_processes_all_texts(self):
        texts = [f"Text {i}" for i in range(5)]
        results = await self.pipeline.embed_batch(texts)

        assert len(results) == 5
        for vec in results:
            assert len(vec) == VECTOR_DIMENSION

    @pytest.mark.asyncio
    async def test_embed_batch_respects_batch_size(self):
        # Create more texts than batch_size
        pipeline = EmbeddingPipeline(
            region="ap-southeast-1",
            boto_client=self.mock_client,
            batch_size=3,
        )
        texts = [f"Text {i}" for i in range(7)]
        results = await pipeline.embed_batch(texts)

        assert len(results) == 7
        # Should have made 7 individual calls (Titan processes one at a time)
        assert self.mock_client.invoke_model.call_count == 7

    @pytest.mark.asyncio
    async def test_embed_document_splits_and_embeds(self):
        # Create a document long enough to require splitting
        text = "This is a test sentence for document embedding. " * 200
        results = await self.pipeline.embed_document(text)

        assert len(results) > 1
        for chunk_text, vector in results:
            assert isinstance(chunk_text, str)
            assert len(chunk_text) > 0
            assert len(vector) == VECTOR_DIMENSION

    @pytest.mark.asyncio
    async def test_embed_document_empty_text(self):
        results = await self.pipeline.embed_document("")
        assert results == []

    @pytest.mark.asyncio
    async def test_embed_document_short_text(self):
        results = await self.pipeline.embed_document("Short text")
        assert len(results) == 1
        assert results[0][0] == "Short text"
        assert len(results[0][1]) == VECTOR_DIMENSION

    @pytest.mark.asyncio
    async def test_retry_on_failure(self):
        """Test that the pipeline retries on transient failures."""
        call_count = 0

        def invoke_model_with_failures(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                raise Exception("Transient error")
            response_body = json.dumps(_make_mock_bedrock_response()).encode()
            return {"body": io.BytesIO(response_body)}

        self.mock_client.invoke_model = MagicMock(side_effect=invoke_model_with_failures)

        # Patch asyncio.sleep to avoid actual delays in tests
        async def mock_sleep(seconds):
            pass

        with patch("src.embeddings.pipeline.asyncio.sleep", side_effect=mock_sleep):
            result = await self.pipeline.embed_text("Test retry")

        assert len(result) == VECTOR_DIMENSION
        assert call_count == 3  # 2 failures + 1 success

    @pytest.mark.asyncio
    async def test_raises_after_max_retries(self):
        """Test that the pipeline raises after exhausting all retries."""
        self.mock_client.invoke_model = MagicMock(
            side_effect=Exception("Persistent error")
        )

        async def mock_sleep(seconds):
            pass

        with patch("src.embeddings.pipeline.asyncio.sleep", side_effect=mock_sleep):
            with pytest.raises(Exception, match="Persistent error"):
                await self.pipeline.embed_text("Test failure")

        # Should have tried MAX_RETRIES times
        assert self.mock_client.invoke_model.call_count == 3
