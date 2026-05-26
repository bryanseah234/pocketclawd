"""
Bedrock Claude client — invokes Claude via AWS Bedrock for AI responses.

Supports conversation history, RAG context injection, and configurable
system prompts. Uses the Converse API for structured message passing.

Requirements: REQ-8.1
"""

import asyncio
import json
import logging
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# Defaults per PRD §8.1.1
DEFAULT_MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0"
DEFAULT_MAX_TOKENS = 4096
DEFAULT_TEMPERATURE = 0.5

SYSTEM_PROMPT = (
    "You are NanoClaw, an AI assistant helping users through WhatsApp. "
    "Keep responses concise and under 500 words unless detailed explanations are requested. "
    "Always cite sources when using information from retrieved documents using the format "
    "Source: filename.pdf, page X. "
    "If the retrieved information does not contain the answer, clearly state that you could not find the information. "
    "Never make up facts or cite documents that were not actually retrieved. "
    "Use bullet points for lists and numbered lists for sequences."
)


class BedrockClaude:
    """
    AWS Bedrock Claude client for generating AI responses.

    Uses the Bedrock Converse API for structured multi-turn conversations
    with system prompt, conversation history, and RAG context.
    """

    def __init__(
        self,
        region: str = "ap-southeast-1",
        model_id: str | None = None,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        temperature: float = DEFAULT_TEMPERATURE,
        boto_client: Any = None,
    ) -> None:
        self.model_id = model_id or DEFAULT_MODEL_ID
        self.max_tokens = max_tokens
        self.temperature = temperature

        if boto_client is not None:
            self._client = boto_client
        else:
            self._client = boto3.client("bedrock-runtime", region_name=region)

    async def generate(
        self,
        user_message: str,
        history: list[dict[str, str]] | None = None,
        rag_context: str | None = None,
        system_prompt: str | None = None,
        temperature: float | None = None,
    ) -> str:
        """
        Generate a response using Bedrock Claude.

        Args:
            user_message: The current user message.
            history: Previous conversation messages [{"role": "user"|"assistant", "content": "..."}]
            rag_context: Retrieved document context to inject before the user message.
            system_prompt: Override the default system prompt.
            temperature: Override the default temperature.

        Returns:
            The assistant's response text.
        """
        messages: list[dict[str, Any]] = []

        # Add conversation history (last 30 messages max)
        if history:
            for msg in history[-30:]:
                messages.append({
                    "role": msg["role"],
                    "content": [{"text": msg["content"]}],
                })

        # Build the current user message with optional RAG context
        user_content = ""
        if rag_context:
            user_content += f"<context>\n{rag_context}\n</context>\n\n"
        user_content += user_message

        messages.append({
            "role": "user",
            "content": [{"text": user_content}],
        })

        # Build the request
        request_body: dict[str, Any] = {
            "modelId": self.model_id,
            "messages": messages,
            "inferenceConfig": {
                "maxTokens": self.max_tokens,
                "temperature": temperature or self.temperature,
            },
        }

        # Add system prompt
        prompt = system_prompt or SYSTEM_PROMPT
        request_body["system"] = [{"text": prompt}]

        # Invoke with retry
        response = await self._invoke_with_retry(request_body)

        # Extract response text
        output = response.get("output", {})
        message = output.get("message", {})
        content_blocks = message.get("content", [])

        response_text = ""
        for block in content_blocks:
            if "text" in block:
                response_text += block["text"]

        return response_text.strip()

    async def _invoke_with_retry(self, request_body: dict[str, Any]) -> dict[str, Any]:
        """Invoke Bedrock Converse API with exponential backoff retry."""
        last_error: Exception | None = None

        for attempt in range(5):
            try:
                loop = asyncio.get_event_loop()
                response = await loop.run_in_executor(
                    None,
                    lambda: self._client.converse(**request_body),
                )
                return response

            except ClientError as e:
                error_code = e.response.get("Error", {}).get("Code", "")
                if error_code in ("ThrottlingException", "ServiceUnavailableException"):
                    last_error = e
                    backoff = (2 ** attempt)
                    logger.warning(
                        "Bedrock throttled (attempt %d/5), retrying in %ds",
                        attempt + 1, backoff,
                    )
                    await asyncio.sleep(backoff)
                else:
                    raise

            except Exception as e:
                last_error = e
                backoff = (2 ** attempt)
                logger.warning("Bedrock error (attempt %d/5): %s", attempt + 1, str(e))
                await asyncio.sleep(backoff)

        raise last_error  # type: ignore[misc]
