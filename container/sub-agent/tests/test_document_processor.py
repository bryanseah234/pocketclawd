"""
Unit tests for the document processing pipeline.

Tests text extractors and DocumentProcessor with mocked embedding pipeline.
"""

import io
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.documents.extractors import (
    extract_csv,
    extract_text,
    extract_txt,
)
from src.documents.processor import DocumentProcessor, IngestionResult
from src.embeddings.pipeline import EmbeddingPipeline, VECTOR_DIMENSION


# ---------------------------------------------------------------------------
# Extractor Tests
# ---------------------------------------------------------------------------


class TestExtractTxt:
    """Tests for plain text extraction."""

    def test_extracts_utf8_text(self):
        content = "Hello, world! This is a test.".encode("utf-8")
        result = extract_txt(content)
        assert result == "Hello, world! This is a test."

    def test_extracts_multiline_text(self):
        content = "Line 1\nLine 2\nLine 3".encode("utf-8")
        result = extract_txt(content)
        assert result == "Line 1\nLine 2\nLine 3"

    def test_extracts_unicode_text(self):
        content = "สวัสดี 你好 こんにちは".encode("utf-8")
        result = extract_txt(content)
        assert result == "สวัสดี 你好 こんにちは"

    def test_extracts_empty_text(self):
        content = b""
        result = extract_txt(content)
        assert result == ""


class TestExtractCsv:
    """Tests for CSV text extraction."""

    def test_extracts_simple_csv(self):
        content = "Name,Age,City\nAlice,30,Singapore\nBob,25,Bangkok".encode("utf-8")
        result = extract_csv(content)
        assert "Name | Age | City" in result
        assert "Name: Alice" in result
        assert "Age: 30" in result
        assert "City: Singapore" in result

    def test_extracts_single_row_csv(self):
        content = "Header1,Header2\nValue1,Value2".encode("utf-8")
        result = extract_csv(content)
        assert "Header1 | Header2" in result
        assert "Header1: Value1" in result

    def test_extracts_empty_csv(self):
        content = b""
        result = extract_csv(content)
        assert result == ""


class TestExtractPdf:
    """Tests for PDF text extraction (mocked)."""

    def test_extracts_text_from_pdf(self):
        """Test PDF extraction with mocked PyPDF2."""
        mock_page = MagicMock()
        mock_page.extract_text.return_value = "Page 1 content"

        mock_reader = MagicMock()
        mock_reader.pages = [mock_page]

        with patch("src.documents.extractors.PdfReader", return_value=mock_reader) as mock_cls:
            # Need to import after patching
            from src.documents.extractors import extract_pdf
            result = extract_pdf(b"fake pdf content")

        assert "Page 1 content" in result

    def test_handles_multi_page_pdf(self):
        """Test multi-page PDF extraction."""
        mock_page1 = MagicMock()
        mock_page1.extract_text.return_value = "First page"
        mock_page2 = MagicMock()
        mock_page2.extract_text.return_value = "Second page"

        mock_reader = MagicMock()
        mock_reader.pages = [mock_page1, mock_page2]

        with patch("src.documents.extractors.PdfReader", return_value=mock_reader):
            from src.documents.extractors import extract_pdf
            result = extract_pdf(b"fake pdf content")

        assert "First page" in result
        assert "Second page" in result


class TestExtractDocx:
    """Tests for DOCX text extraction (mocked)."""

    def test_extracts_text_from_docx(self):
        """Test DOCX extraction with mocked python-docx."""
        mock_para1 = MagicMock()
        mock_para1.text = "First paragraph"
        mock_para2 = MagicMock()
        mock_para2.text = "Second paragraph"

        mock_doc = MagicMock()
        mock_doc.paragraphs = [mock_para1, mock_para2]

        with patch("src.documents.extractors.Document", return_value=mock_doc):
            from src.documents.extractors import extract_docx
            result = extract_docx(b"fake docx content")

        assert "First paragraph" in result
        assert "Second paragraph" in result

    def test_skips_empty_paragraphs(self):
        """Test that empty paragraphs are skipped."""
        mock_para1 = MagicMock()
        mock_para1.text = "Content"
        mock_para2 = MagicMock()
        mock_para2.text = "   "  # whitespace only
        mock_para3 = MagicMock()
        mock_para3.text = "More content"

        mock_doc = MagicMock()
        mock_doc.paragraphs = [mock_para1, mock_para2, mock_para3]

        with patch("src.documents.extractors.Document", return_value=mock_doc):
            from src.documents.extractors import extract_docx
            result = extract_docx(b"fake docx content")

        assert "Content" in result
        assert "More content" in result
        # Empty paragraph should not create extra blank lines
        lines = [l for l in result.split("\n\n") if l.strip()]
        assert len(lines) == 2


class TestExtractImage:
    """Tests for image OCR extraction (mocked)."""

    def test_extracts_text_from_image(self):
        """Test image OCR with mocked pytesseract."""
        mock_image = MagicMock()

        with patch("src.documents.extractors.Image") as mock_pil:
            mock_pil.open.return_value = mock_image
            with patch("src.documents.extractors.pytesseract") as mock_tess:
                mock_tess.image_to_string.return_value = "OCR extracted text"
                from src.documents.extractors import extract_image
                result = extract_image(b"fake image bytes")

        assert result == "OCR extracted text"


class TestExtractTextRouter:
    """Tests for the extract_text routing function."""

    def test_routes_plain_text(self):
        content = "Hello world".encode("utf-8")
        result = extract_text(content, "text/plain")
        assert result == "Hello world"

    def test_routes_csv(self):
        content = "A,B\n1,2".encode("utf-8")
        result = extract_text(content, "text/csv")
        assert "A | B" in result

    def test_raises_for_unsupported_type(self):
        with pytest.raises(ValueError, match="Unsupported content type"):
            extract_text(b"data", "application/unknown")

    def test_handles_content_type_with_charset(self):
        content = "Hello".encode("utf-8")
        result = extract_text(content, "text/plain; charset=utf-8")
        assert result == "Hello"

    def test_routes_pdf(self):
        """Test that PDF content type routes to extract_pdf."""
        with patch("src.documents.extractors.extract_pdf", return_value="pdf text") as mock:
            # We need to reimport to pick up the patch on the module-level function
            # Instead, patch at the lookup level
            pass

        # Test via the router with mocked PyPDF2
        mock_page = MagicMock()
        mock_page.extract_text.return_value = "PDF content"
        mock_reader = MagicMock()
        mock_reader.pages = [mock_page]

        with patch("src.documents.extractors.PdfReader", return_value=mock_reader):
            result = extract_text(b"fake pdf", "application/pdf")
        assert "PDF content" in result

    def test_routes_image_png(self):
        """Test that image/png routes to extract_image."""
        mock_image = MagicMock()
        with patch("src.documents.extractors.Image") as mock_pil:
            mock_pil.open.return_value = mock_image
            with patch("src.documents.extractors.pytesseract") as mock_tess:
                mock_tess.image_to_string.return_value = "Image text"
                result = extract_text(b"fake png", "image/png")
        assert result == "Image text"


# ---------------------------------------------------------------------------
# DocumentProcessor Tests
# ---------------------------------------------------------------------------


def _make_mock_embedding_pipeline() -> EmbeddingPipeline:
    """Create a mock EmbeddingPipeline that returns fake vectors."""
    pipeline = MagicMock(spec=EmbeddingPipeline)

    async def mock_embed_batch(texts: list[str]) -> list[list[float]]:
        return [[0.1] * VECTOR_DIMENSION for _ in texts]

    pipeline.embed_batch = AsyncMock(side_effect=mock_embed_batch)
    return pipeline


class TestDocumentProcessor:
    """Tests for the DocumentProcessor class."""

    def setup_method(self):
        self.mock_pipeline = _make_mock_embedding_pipeline()
        self.processor = DocumentProcessor(
            embedding_pipeline=self.mock_pipeline,
            user_id="test-user-123",
        )

    @pytest.mark.asyncio
    async def test_process_plain_text_document(self):
        content = ("This is a test document with enough content. " * 10).encode("utf-8")
        result = await self.processor.process_document(
            "test.txt", content, "text/plain"
        )

        assert isinstance(result, IngestionResult)
        assert result.filename == "test.txt"
        assert result.user_id == "test-user-123"
        assert result.status == "success"
        assert result.chunk_count >= 1
        assert result.total_tokens > 0
        assert result.error is None

    @pytest.mark.asyncio
    async def test_process_csv_document(self):
        content = "Name,Score\nAlice,95\nBob,87\nCharlie,92".encode("utf-8")
        result = await self.processor.process_document(
            "data.csv", content, "text/csv"
        )

        assert result.status == "success"
        assert result.chunk_count >= 1
        assert result.filename == "data.csv"

    @pytest.mark.asyncio
    async def test_process_large_document_produces_multiple_chunks(self):
        # Create a document large enough to require multiple chunks
        content = ("Word " * 2000).encode("utf-8")
        result = await self.processor.process_document(
            "large.txt", content, "text/plain"
        )

        assert result.status == "success"
        assert result.chunk_count > 1
        assert result.total_tokens > 512

    @pytest.mark.asyncio
    async def test_process_empty_document_fails(self):
        content = b""
        result = await self.processor.process_document(
            "empty.txt", content, "text/plain"
        )

        assert result.status == "failed"
        assert result.chunk_count == 0
        assert result.error is not None
        assert "No text" in result.error

    @pytest.mark.asyncio
    async def test_process_whitespace_only_document_fails(self):
        content = "   \n\n   \t  ".encode("utf-8")
        result = await self.processor.process_document(
            "blank.txt", content, "text/plain"
        )

        assert result.status == "failed"
        assert "No text" in result.error

    @pytest.mark.asyncio
    async def test_process_unsupported_content_type_fails(self):
        result = await self.processor.process_document(
            "file.xyz", b"data", "application/x-unknown"
        )

        assert result.status == "failed"
        assert "Unsupported content type" in result.error

    @pytest.mark.asyncio
    async def test_process_document_calls_embed_batch(self):
        content = "Some document content for embedding.".encode("utf-8")
        await self.processor.process_document("doc.txt", content, "text/plain")

        self.mock_pipeline.embed_batch.assert_called_once()
        call_args = self.mock_pipeline.embed_batch.call_args[0][0]
        assert isinstance(call_args, list)
        assert all(isinstance(chunk, str) for chunk in call_args)

    @pytest.mark.asyncio
    async def test_process_document_handles_embedding_failure(self):
        self.mock_pipeline.embed_batch = AsyncMock(
            side_effect=Exception("Bedrock unavailable")
        )

        content = "Some content to process.".encode("utf-8")
        result = await self.processor.process_document(
            "doc.txt", content, "text/plain"
        )

        assert result.status == "failed"
        assert "Bedrock unavailable" in result.error

    @pytest.mark.asyncio
    async def test_ingestion_result_model_fields(self):
        result = IngestionResult(
            filename="test.pdf",
            user_id="user-1",
            chunk_count=5,
            total_tokens=2048,
            status="success",
        )

        assert result.filename == "test.pdf"
        assert result.user_id == "user-1"
        assert result.chunk_count == 5
        assert result.total_tokens == 2048
        assert result.status == "success"
        assert result.error is None

    @pytest.mark.asyncio
    async def test_ingestion_result_with_error(self):
        result = IngestionResult(
            filename="bad.pdf",
            user_id="user-2",
            chunk_count=0,
            total_tokens=0,
            status="failed",
            error="Corrupt file",
        )

        assert result.status == "failed"
        assert result.error == "Corrupt file"
