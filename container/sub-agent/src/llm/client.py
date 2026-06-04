"""
Bedrock Claude client — invokes Claude via AWS Bedrock for AI responses.

Supports conversation history, RAG context injection, and configurable
system prompts. Uses the Converse API for structured message passing.

Requirements: REQ-8.1
"""

import asyncio
import json
import logging
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# Defaults per PRD §8.1.1
DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-4-6"
DEFAULT_MAX_TOKENS = 800  # WA messages should be concise; reduces latency
DEFAULT_TEMPERATURE = 0.5

_PERSONA_CANDIDATES = [
    # /app/src/persona/ -- correct path after COPY src/ ./src/
    "/app/src/persona/system_prompt_template.json",
    # relative from src/llm/client.py -> ../persona/
    os.path.join(os.path.dirname(__file__), "../persona/system_prompt_template.json"),
    # legacy fallbacks
    "/app/persona/system_prompt_template.json",
    os.path.join(os.path.dirname(__file__), "../../../persona/system_prompt_template.json"),
]

_SECTION_ORDER = [
    "identity", "voice", "formatting", "memory", "capabilities",
    "knowledgeBase", "photos", "guardrails", "confidence",
    "interactionStyle", "namingDiscipline",
]

_HONESTY_ADDENDUM = """

## Live Web Access
You have live tools. Use them ONLY when the user's current message specifically asks for that information:
- News / recent events / "what happened today" → call web_search
- Weather for a city → call get_weather (only if user asks about weather)
- Currency conversion → call convert_currency (only if user asks to convert)
- Stock or crypto price → call get_stock_price or get_crypto_price (only if user asks for a price)
- Singapore PSI or haze → call get_sg_psi (ONLY if user explicitly asks about haze, air quality, or PSI)
- ISS location → call get_iss_location (ONLY if user explicitly asks about the ISS or space station)
- Someone pastes a URL → call fetch_url to read it
Do NOT say "I can't browse the web" — you CAN. Just call the tool.
Do NOT call tools the user did not ask for. Do NOT call PSI/ISS/weather unless the message is about those topics.

## What You Genuinely Cannot Do Yet
- Calendar / email: not connected. Say "coming soon".
- If a tool call fails, say so plainly and offer to try differently.
"""


def _load_system_prompt() -> str:
    """Load persona JSON and assemble system prompt. Falls back to minimal prompt."""
    import re as _re
    for path in _PERSONA_CANDIDATES:
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                data = json.loads(f.read())
            sections = data.get("sections", {})
            parts = []
            for key in _SECTION_ORDER:
                v = sections.get(key, "")
                if isinstance(v, str) and v.strip():
                    heading = _re.sub(r"([A-Z])", r" \1", key).strip().title()
                    parts.append(f"## {heading}\n{v.strip()}")
            examples = sections.get("examples", [])
            if examples:
                ex_lines = ["## Examples"]
                for e in examples:
                    if e.get("input") and e.get("good"):
                        line = f"User: {e['input']}\nGood: {e['good']}"
                        if e.get("bad"):
                            line += f"\nBad (avoid): {e['bad']}"
                        ex_lines.append(line)
                parts.append("\n\n".join(ex_lines))
            prompt = "\n\n".join(parts) + _HONESTY_ADDENDUM
            logger.info("Persona loaded from %s (%d chars)", path, len(prompt))
            return prompt
        except Exception as exc:
            logger.warning("Failed to load persona from %s: %s", path, exc)

    logger.warning("No persona JSON found — using minimal fallback prompt")
    return (
        "You are Clawd, a warm personal AI assistant on WhatsApp. Be concise, match the user's energy. "
        "Singapore-friendly — match light Singlish when the user uses it. Never say 'As an AI...'. "
        "You cannot browse live web or check current news — say so plainly." + _HONESTY_ADDENDUM
    )


SYSTEM_PROMPT = _load_system_prompt()


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
        self.model_id = model_id or os.environ.get("BEDROCK_LLM_MODEL_ID") or DEFAULT_MODEL_ID
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
        user_profile: dict | None = None,
        image_bytes_list: list[tuple[bytes, str]] | None = None,
    ) -> tuple[str, list[str]]:
        """
        Generate a response using Bedrock Claude with tool-use support.

        Returns (response_text, tools_used) -- tools_used is the list of tool
        names that actually fired this turn, for the provenance footer.

        Runs a multi-turn tool-use loop: if the model requests a tool call,
        we execute the tool and feed the result back, up to MAX_TOOL_TURNS.
        """
        from src.tools import TOOL_DEFINITIONS, dispatch_tool

        MAX_TOOL_TURNS = 6  # safety cap on tool call chain depth

        messages: list[dict[str, Any]] = []

        # Add conversation history (last 100 messages max)
        # Skip blank-content messages — Bedrock Converse rejects empty text fields.
        if history:
            for msg in history[-100:]:
                content = (msg.get("content") or "").strip()
                if not content:
                    continue
                messages.append({
                    "role": msg["role"],
                    "content": [{"text": content}],
                })

        # Build the current user message with optional RAG context
        from datetime import datetime, timezone as _tz
        _now = datetime.now(_tz.utc).strftime("%Y-%m-%d %H:%M UTC")
        user_content = f"[Current date/time: {_now}]\n\n"
        if rag_context:
            user_content += f"<context>\n{rag_context}\n</context>\n\n"
        user_content += user_message

        # Build user content blocks: images first (if any), then text
        import base64 as _b64
        _user_blocks: list[dict] = []
        if image_bytes_list:
            for _img_b, _img_mime in image_bytes_list:
                _user_blocks.append({
                    "image": {
                        "format": _img_mime.split("/")[-1].replace("jpeg","jpeg"),
                        "source": {
                            "bytes": _img_b,
                        },
                    }
                })
        _user_blocks.append({"text": user_content})
        messages.append({
            "role": "user",
            "content": _user_blocks,
        })

        prompt = system_prompt or SYSTEM_PROMPT

        # Inject user profile so the model addresses them correctly
        if user_profile:
            name = user_profile.get("display_name") or user_profile.get("name", "")
            use_case = user_profile.get("use_case", "")
            style = user_profile.get("reply_style") or user_profile.get("replyStyle", "")
            tech_depth = user_profile.get("technical_depth", "")
            profile_lines = []
            if name:
                profile_lines.append(f"The user's name is {name}. Address them by name occasionally.")
            if use_case:
                profile_lines.append(f"Their primary use case: {use_case}.")
            if style == "short":
                profile_lines.append("They prefer SHORT replies — be punchy, 1-3 sentences unless detail is needed.")
            elif style == "detailed":
                profile_lines.append("They prefer DETAILED replies — give full context and steps.")
            if tech_depth == "high-level":
                profile_lines.append("Keep explanations high-level, no jargon.")
            elif tech_depth == "detailed":
                profile_lines.append("They're technical — go deep on implementation details.")
            if profile_lines:
                prompt += "\n\n## User Profile\n" + "\n".join(profile_lines)

        # Reinforce tool use + formatting + follow-up rules
        prompt += (
            "\n\n## Tool Use Rules (MANDATORY)\n"
            "You MUST call tools for LIVE/REAL-TIME data. Do NOT call tools for stable facts.\n"
            "CALL a tool for: current weather, live prices, recent news/events (post early 2025), currency rates, user-pasted URLs.\n"
            "DO NOT call web_search for: who someone is, historical facts, general knowledge, definitions, well-known laws/science.\n"
            "- Weather/forecast → get_weather or get_sg_weather\n"
            "- Currency conversion → convert_currency\n"
            "- Crypto/stock CURRENT price → get_crypto_price or get_stock_price\n"
            "- News or events after early 2025 → web_search\n"
            "- Singapore PSI/haze → get_sg_psi\n"
            "- User sends a URL → fetch_url\n"
            "- User asks for a document, report, letter, summary to save/download → generate_document\n"
            "- User asks to draw/generate/create an image → generate_image\n"
            "Rule: if you ALREADY KNOW the answer with high confidence (stable facts like PM names, capitals, laws, math) → answer directly WITHOUT any tool call.\n"
            "\n## Media Delivery Rules (CRITICAL)\n"
            "When generate_image returns IMAGE_URL:...:IMAGE_URL — your ENTIRE reply must be ONLY that marker.\n"
            "Do NOT add prose, caption, or any other text around it. The system extracts it automatically.\n"
            "When generate_document returns DOC_URL:...:DOC_URL — your ENTIRE reply must be ONLY that marker.\n"
            "Do NOT say 'Here is your document' or add any text around the DOC_URL marker."
            "\n\n## Response Format Rules\n"
            "1. Answer first — direct, clear, no preamble.\n"
            "2. Do NOT append a Sources: line yourself -- the system adds a precise,\n"
            "   typed source line automatically based on what was actually used.\n"
            "3. If a web_search result is central, you MAY cite the specific [Title](url)\n"
            "   inline in the prose, but never a trailing Sources: block.\n"
            "4. End EVERY response with exactly one brief follow-up question OR a yes/no prompt\n"
            "   that moves the conversation forward. Keep it to one short sentence.\n"
            "   Examples: 'Want more detail?' / 'Anything else?' / 'Want me to set a reminder?'\n"
            "5. WhatsApp formatting: *bold* for key terms, _italics_ for asides.\n"
            "   No markdown headers (##). No bullet walls — max 4 bullets.\n"
            "6. Never say 'As an AI', 'I cannot', 'I'm unable'. Just do it or offer an alternative."
        )
        inference_cfg: dict[str, Any] = {
            "maxTokens": self.max_tokens,
            "temperature": temperature or self.temperature,
        }

        tools_used: list[str] = []
        for _turn in range(MAX_TOOL_TURNS):
            request_body: dict[str, Any] = {
                "modelId": self.model_id,
                "messages": messages,
                "inferenceConfig": inference_cfg,
                "system": [{"text": prompt}],
                "toolConfig": {"tools": TOOL_DEFINITIONS},
            }

            response = await self._invoke_with_retry(request_body)
            stop_reason = response.get("stopReason", "")
            output_msg = response.get("output", {}).get("message", {})
            content_blocks = output_msg.get("content", [])

            if stop_reason == "tool_use":
                # Append assistant's tool-use request to messages
                messages.append({"role": "assistant", "content": content_blocks})

                # Execute all requested tools and collect results
                tool_results = []
                for block in content_blocks:
                    if "toolUse" not in block:
                        continue
                    tool_id = block["toolUse"]["toolUseId"]
                    tool_name = block["toolUse"]["name"]
                    tool_input = block["toolUse"]["input"]
                    logger.info("Tool call: %s %s", tool_name, tool_input)
                    if tool_name not in tools_used:
                        tools_used.append(tool_name)
                    result_text = await dispatch_tool(tool_name, tool_input)
                    tool_results.append({
                        "toolResult": {
                            "toolUseId": tool_id,
                            "content": [{"text": result_text}],
                            "status": "success",
                        }
                    })

                # Feed tool results back
                messages.append({"role": "user", "content": tool_results})
                continue  # next turn — model will now answer with tool results

            # end_turn or max_tokens — extract final text
            response_text = ""
            for block in content_blocks:
                if "text" in block:
                    response_text += block["text"]
            return response_text.strip(), tools_used

        # Exceeded MAX_TOOL_TURNS — extract whatever text we have
        response_text = ""
        for block in content_blocks:
            if "text" in block:
                response_text += block["text"]
        return (response_text.strip() or "Sorry, I ran into an issue processing that. Try again."), tools_used

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

