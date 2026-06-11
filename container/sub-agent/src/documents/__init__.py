"""
Document processing pipeline for NanoClaw sub-agent.

Provides document ingestion: upload → text extraction → chunking → embedding → indexing.
Supports PDF, DOCX, CSV, TXT, and image files.
Provides document management commands: /list, /delete, /update with webhook confirmation.

Requirements: REQ-5.1, REQ-5.2
"""

from src.documents.commands import (
    CommandResult,
    CommandType,
    DocumentCommands,
    DocumentInfo,
    UserPreferences,
    WebhookToken,
    WebhookTokenManager,
    is_document_command,
    parse_command,
)
from src.documents.extractors import extract_text
from src.documents.processor import DocumentProcessor, IngestionResult

__all__ = [
    "CommandResult",
    "CommandType",
    "DocumentCommands",
    "DocumentInfo",
    "DocumentProcessor",
    "IngestionResult",
    "UserPreferences",
    "WebhookToken",
    "WebhookTokenManager",
    "extract_text",
    "is_document_command",
    "parse_command",
]
