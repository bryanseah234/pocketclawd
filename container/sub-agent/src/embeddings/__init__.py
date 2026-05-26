"""Embedding pipeline — Bedrock Titan Embeddings client and document chunking."""

from .pipeline import EmbeddingPipeline, RecursiveCharacterSplitter

__all__ = ["EmbeddingPipeline", "RecursiveCharacterSplitter"]
