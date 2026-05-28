"""
F1 (Wave 9): Bedrock vision describer.

Replaces (or augments) pytesseract OCR for image documents using Claude
Sonnet 4.5's native vision via Bedrock InvokeModel. Extracts both:
- Text visible in the image (OCR-equivalent)
- A short natural-language description (what the image is about)

Gated by env var CLAWD_VISION_PROVIDER:
- "bedrock" (default in cloud) — call Bedrock vision
- "tesseract" — fall back to pytesseract OCR (legacy / offline)
- "auto" — try Bedrock; on any failure, fall back to tesseract

The function is synchronous to match extractors.extract_image\'s signature.
Bedrock InvokeModel accepts up to 5MB per image; we resize down if needed.
"""
from __future__ import annotations

import base64
import io
import logging
import os
from typing import Final

logger = logging.getLogger(__name__)

# Match extract_image's signature (sync, bytes -> str).
DEFAULT_VISION_PROMPT: Final[str] = (
    "You are reading an image a user shared with their personal assistant. "
    "Output two short sections separated by a blank line:\n\n"
    "TEXT:\n<all readable text in the image, exactly as it appears, or 'None visible.'>\n\n"
    "DESCRIPTION:\n<2-3 sentences plainly describing what the image shows, "
    "the setting, and anything noteworthy. Be factual; do not infer mood.>"
)

VISION_MODEL_ID: Final[str] = os.environ.get(
    "CLAWD_VISION_MODEL_ID",
    "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
)

MAX_IMAGE_BYTES: Final[int] = 5 * 1024 * 1024  # 5MB Bedrock limit
MAX_IMAGE_DIM: Final[int] = 2048  # downscale anything larger


def _provider() -> str:
    """Resolve the vision provider from env, defaulting to bedrock."""
    return os.environ.get("CLAWD_VISION_PROVIDER", "bedrock").lower()


def _resize_if_needed(content: bytes) -> tuple[bytes, str]:
    """Resize the image if it\'s over 5MB or has very large dimensions.

    Returns (bytes, mediaType). MediaType is one of \'image/jpeg\' / \'image/png\'.
    Defaults to image/jpeg after re-encoding.
    """
    try:
        from PIL import Image  # noqa: WPS433
    except Exception:
        # PIL missing — assume jpeg, return as-is
        return content, "image/jpeg"

    if len(content) <= MAX_IMAGE_BYTES:
        # Still inspect dimensions
        try:
            with Image.open(io.BytesIO(content)) as im:
                if max(im.size) <= MAX_IMAGE_DIM:
                    fmt = (im.format or "JPEG").upper()
                    media = "image/png" if fmt == "PNG" else "image/jpeg"
                    return content, media
        except Exception:
            return content, "image/jpeg"

    # Resize
    try:
        with Image.open(io.BytesIO(content)) as im:
            im = im.convert("RGB")
            im.thumbnail((MAX_IMAGE_DIM, MAX_IMAGE_DIM))
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=85, optimize=True)
            return buf.getvalue(), "image/jpeg"
    except Exception as exc:
        logger.warning("Image resize failed; sending as-is: %s", exc)
        return content, "image/jpeg"


def describe_with_bedrock(content: bytes, prompt: str | None = None) -> str:
    """Call Bedrock vision and return the model\'s natural-language answer."""
    import json
    import boto3

    region = os.environ.get("AWS_REGION", "ap-southeast-1")
    client = boto3.client("bedrock-runtime", region_name=region)

    bytes_in, media_type = _resize_if_needed(content)
    b64 = base64.standard_b64encode(bytes_in).decode("ascii")

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64,
                        },
                    },
                    {"type": "text", "text": prompt or DEFAULT_VISION_PROMPT},
                ],
            }
        ],
    }

    resp = client.invoke_model(
        modelId=VISION_MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=json.dumps(body).encode("utf-8"),
    )
    payload = json.loads(resp["body"].read().decode("utf-8"))
    blocks = payload.get("content", [])
    return "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()


def describe_image(content: bytes, prompt: str | None = None) -> str:
    """Top-level extractor entry point used by documents/extractors.py.

    Routes based on CLAWD_VISION_PROVIDER:
    - "bedrock"   — must succeed; raises on any failure
    - "tesseract" — pytesseract OCR only
    - "auto"      — try bedrock, fall back to tesseract on any error
    """
    provider = _provider()

    def _tesseract() -> str:
        from PIL import Image
        import pytesseract

        with Image.open(io.BytesIO(content)) as im:
            return pytesseract.image_to_string(im)

    if provider == "tesseract":
        return _tesseract()

    try:
        return describe_with_bedrock(content, prompt)
    except Exception as exc:
        if provider == "auto":
            logger.warning("Bedrock vision failed, falling back to tesseract: %s", exc)
            try:
                return _tesseract()
            except Exception as exc2:
                logger.error("Tesseract fallback also failed: %s", exc2)
                return ""
        # provider=="bedrock" — surface the error so callers see it
        raise
