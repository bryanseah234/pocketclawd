"""
Document processor — orchestrates text extraction, chunking, and embedding.

Provides the DocumentProcessor class that handles the full document ingestion
pipeline: extract text → split into chunks → embed → return results.

Requirements: REQ-5.1, REQ-3.2
"""

import logging

from pydantic import BaseModel

from src.documents.extractors import extract_text
from src.embeddings.pipeline import EmbeddingPipeline, RecursiveCharacterSplitter

logger = logging.getLogger(__name__)


class IngestionResult(BaseModel):
    """Result of a document ingestion operation."""

    filename: str
    user_id: str
    chunk_count: int
    total_tokens: int
    status: str  # 'success', 'partial', 'failed'
    error: str | None = None


class DocumentProcessor:
    """
    Orchestrates the document processing pipeline.

    Pipeline steps:
    1. Extract text from the document using the appropriate extractor
    2. Split text into chunks using RecursiveCharacterSplitter
    3. Embed all chunks using EmbeddingPipeline
    4. Return IngestionResult with chunk count and status

    Usage:
        processor = DocumentProcessor(embedding_pipeline, user_id="user123")
        result = await processor.process_document("report.pdf", content, "application/pdf")
    """

    def __init__(self, embedding_pipeline: EmbeddingPipeline, user_id: str) -> None:
        self._embedding_pipeline = embedding_pipeline
        self._user_id = user_id
        self._splitter = RecursiveCharacterSplitter()

    async def process_document(
        self, filename: str, content: bytes, content_type: str
    ) -> IngestionResult:
        """
        Process a document through the full ingestion pipeline.

        Args:
            filename: Name of the file being processed.
            content: Raw file bytes.
            content_type: MIME type of the file.

        Returns:
            IngestionResult with chunk count, token count, and status.
        """
        try:
            # Step 1: Extract text
            text = extract_text(content, content_type)

            if not text.strip():
                return IngestionResult(
                    filename=filename,
                    user_id=self._user_id,
                    chunk_count=0,
                    total_tokens=0,
                    status="failed",
                    error="No text could be extracted from the document",
                )

            # Step 2: Split into chunks
            chunks = self._splitter.split_text(text)

            if not chunks:
                return IngestionResult(
                    filename=filename,
                    user_id=self._user_id,
                    chunk_count=0,
                    total_tokens=0,
                    status="failed",
                    error="Text splitting produced no chunks",
                )

            # Step 3: Embed all chunks
            embeddings = await self._embedding_pipeline.embed_batch(chunks)

            # Calculate total tokens across all chunks
            total_tokens = sum(
                self._splitter._token_length(chunk) for chunk in chunks
            )

            logger.info(
                "Processed document '%s' for user '%s': %d chunks, %d tokens",
                filename,
                self._user_id,
                len(chunks),
                total_tokens,
            )

            return IngestionResult(
                filename=filename,
                user_id=self._user_id,
                chunk_count=len(chunks),
                total_tokens=total_tokens,
                status="success",
            )

        except ValueError as e:
            # Unsupported content type or extraction error
            logger.warning(
                "Document processing failed for '%s': %s", filename, str(e)
            )
            return IngestionResult(
                filename=filename,
                user_id=self._user_id,
                chunk_count=0,
                total_tokens=0,
                status="failed",
                error=str(e),
            )

        except Exception as e:
            # Partial failure — some chunks may have been processed
            logger.error(
                "Unexpected error processing '%s' for user '%s': %s",
                filename,
                self._user_id,
                str(e),
                exc_info=True,
            )
            return IngestionResult(
                filename=filename,
                user_id=self._user_id,
                chunk_count=0,
                total_tokens=0,
                status="failed",
                error=f"Processing error: {str(e)}",
            )
