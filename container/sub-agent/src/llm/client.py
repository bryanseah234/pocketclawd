"""
Bedrock Claude LLM client — calls AWS Bedrock for AI responses.

Uses Claude 3.5 Sonnet via the Bedrock InvokeModel API with conversation
history and RAG context formatting.

Requirements: REQ-8.1
"""

import asyncio
import json
import logging
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# Retry configuration
MAX_RETRIES = 3
BACKOFF_BASE_SECONDS = 1.0

# Model configuration
DEFAULT_MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0"
MAX_OUTPUT_TOKENS = 4096

# System prompt per PRD §8.1.3
SYSTEM_PROMPT = """You are NanoClaw, an AI assistant helping users through WhatsApp.

Rules:
- Keep responses concise and under 500 words unless detailed explanations are requested.
- Always cite sources when using information from retrieved documents using the format: Source: filename, page X.
- If the retrieved information does not contain the answer, clearly state that you could not find the information.
- Never make up facts or cite documents that were not actually retrieved.
- Use bullet points for lists and numbered lists for sequences.
- When generating code, include comments and ensure the code is complete and functional.
- Be helpful, direct, and professional."""


class BedrockLLMClient:
    """
    AWS Bedrock Claude client with retry and conversation history support.

    Usage:
        client = BedrockLLMClient(region="ap-southeast-1")
        response = await client.chat(messages, rag_context=context)
    """

    def __init__(
        self,
        region: str = "ap-southeast-1",
        model_id: str = DEFAULT_MODEL_ID,
        boto_client: Any = None,
    ) -> None:
        self.region = region
        self.model_id = model_id

        if boto_client is not None:
            self._client = boto_client
        else:
            self._client = boto3.client(
                "bedrock-runtime",
                region_name=region,
            )

    async def chat(
        self,
        messages: list[dict[str, str]],
        rag_context: str | None = None,
        temperature: float = 0.5,
        max_tokens: int = MAX_OUTPUT_TOKENS,
    ) -> str:
        """
        Send a conversation to Claude and get a response.

        Args:
            messages: List of {"role": "user"|"assistant", "content": "..."} dicts.
            rag_context: Optional RAG context to prepend to the system prompt.
            temperature: Sampling temperature (0.2 for RAG, 0.5 for chat, 0.8 for creative).
            max_tokens: Maximum output tokens.

        Returns:
            The assistant's response text.
        """
        system_prompt = SYSTEM_PROMPT
        if rag_context:
            system_prompt += f"\n\n--- Retrieved Documents ---\n{rag_context}\n--- End Retrieved Documents ---"

        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": system_prompt,
            "messages": messages,
        }

        response = await self._invoke_with_retry(body)
        content = response.get("content", [])

        if content and isinstance(content, list):
            return content[0].get("text", "")
        return ""

    async def _invoke_with_retry(self, body: dict[str, Any]) -> dict[str, Any]:
        """Call Bedrock InvokeModel with exponential backoff retry."""
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
                return json.loads(response["body"].read())

            except ClientError as e:
                last_error = e
                error_code = e.response.get("Error", {}).get("Code", "")
                logger.warning(
                    "Bedrock LLM attempt %d/%d failed: %s (%s)",
                    attempt + 1, MAX_RETRIES, str(e), error_code,
                )

                # Don't retry on validation errors
                if error_code in ("ValidationException", "AccessDeniedException"):
                    raise

                if attempt < MAX_RETRIES - 1:
                    backoff = BACKOFF_BASE_SECONDS * (2 ** attempt)
                    await asyncio.sleep(backoff)

            except Exception as e:
                last_error = e
                logger.warning(
                    "Bedrock LLM attempt %d/%d failed: %s",
                    attempt + 1, MAX_RETRIES, str(e),
                )
                if attempt < MAX_RETRIES - 1:
                    backoff = BACKOFF_BASE_SECONDS * (2 ** attempt)
                    await asyncio.sleep(backoff)

        raise last_error  # type: ignore[misc]


def format_rag_context(chunks: list[dict[str, Any]]) -> str:
    """
    Format retrieved document chunks into context for the LLM.

    Each chunk includes source attribution (filename, page number, relevance score).

    Args:
        chunks: List of search result dicts with content, filename, pageNumber, score.

    Returns:
        Formatted context string for injection into the system prompt.
    """
    if not chunks:
        return ""

    sections: list[str] = []
    for i, chunk in enumerate(chunks, 1):
        filename = chunk.get("filename", "unknown")
        page = chunk.get("pageNumber", 0)
        score = chunk.get("score", 0)
        content = chunk.get("content", "")

        header = f"[Source {i}: {filename}"
        if page > 0:
            header += f", page {page}"
        header += f" (relevance: {score:.2f})]"

        sections.append(f"{header}\n{content}")

    return "\n\n".join(sections)


def format_chat_history(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    """
    Format DynamoDB chat history into Bedrock Messages API format.

    Args:
        messages: List of chat message dicts from DynamoDB (role, content, timestamp).

    Returns:
        List of {"role": "user"|"assistant", "content": "..."} for the Messages API.
    """
    formatted: list[dict[str, str]] = []

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if role in ("user", "assistant") and content.strip():
            formatted.append({"role": role, "content": content})

    # Ensure messages alternate user/assistant (Bedrock requirement)
    # If two consecutive messages have the same role, merge them
    merged: list[dict[str, str]] = []
    for msg in formatted:
        if merged and merged[-1]["role"] == msg["role"]:
            merged[-1]["content"] += "\n" + msg["content"]
        else:
            merged.append(msg)

    # Ensure first message is from user
    if merged and merged[0]["role"] == "assistant":
        merged = merged[1:]

    return merged
