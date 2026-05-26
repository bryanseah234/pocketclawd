"""LLM integration module — Bedrock client with circuit breaker and retry logic."""

from .bedrock_client import BedrockClient, TaskType

__all__ = ["BedrockClient", "TaskType"]
