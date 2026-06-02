"""
URL auto-ingestion — silent fetch + index for URLs detected in user DMs.

Per Q8: when a user sends a message containing http(s) URLs, fetch each URL
silently in the background, extract text, embed, and index just like any
other document. The URL becomes searchable via the normal RAG pipeline.

Per Q9: refresh is on-demand only — we do NOT periodically re-fetch URLs.
The user can /delete <url-key> if they want to drop one and re-paste it
to re-ingest.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import secrets
import urllib.parse
from datetime import datetime, timezone

import httpx
from redis.asyncio import Redis

logger = logging.getLogger(__name__)

URL_PATTERN = re.compile(r"https?://[^\s<>\)\]\}]+", re.IGNORECASE)

# Conservative per-host blocklist (private IPs, file://, anything that smells
# like SSRF). Real production should resolve and check the IP class.
_BLOCKED_HOSTS = {
    "localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254",  # AWS metadata
}

# Cap fetch size at 5MB to bound resource use.
MAX_FETCH_BYTES = 5 * 1024 * 1024
FETCH_TIMEOUT = 15  # seconds


def extract_urls(text: str) -> list[str]:
    """Return de-duplicated list of http(s) URLs in the given text."""
    if not text:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for m in URL_PATTERN.finditer(text):
        u = m.group(0).rstrip(".,;:!?\"\'")
        if u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def _is_safe(url: str) -> bool:
    """Reject obviously-unsafe URLs (private IPs, metadata, file://)."""
    try:
        p = urllib.parse.urlparse(url)
    except (ValueError, AttributeError):
        return False
    if p.scheme not in ("http", "https"):
        return False
    host = (p.hostname or "").lower()
    if not host:
        return False
    if host in _BLOCKED_HOSTS:
        return False
    # Private subnets — basic check
    if host.startswith("10.") or host.startswith("192.168.") or host.startswith("172."):
        return False
    return True


def _doc_id_for(url: str) -> str:
    """Stable doc ID from URL — sha256 first 16 hex chars."""
    return "url-" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]


async def _fetch(url: str) -> tuple[str, str] | None:
    """Fetch URL → (text, content_type) or None on failure."""
    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=FETCH_TIMEOUT,
            headers={"User-Agent": "ClawdBot/1.0 (+https://clawd.ai)"},
        ) as client:
            r = await client.get(url)
            r.raise_for_status()
            ct = r.headers.get("content-type", "text/html").split(";")[0].strip()
            content = r.content[:MAX_FETCH_BYTES]
            # Lightweight HTML→text: strip tags. For richer extraction use
            # the existing documents/extractors module via download → process.
            if "html" in ct:
                # Strip HTML tags inline — extract_text does not handle text/html
                raw = content.decode("utf-8", errors="replace")
                import re as _re
                # Remove scripts, styles, and tags; collapse whitespace
                raw = _re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw, flags=_re.S | _re.I)
                raw = _re.sub(r"<[^>]+>", " ", raw)
                text = _re.sub(r"[ \t]+", " ", raw).strip()
            elif "pdf" in ct:
                from src.documents.extractors import extract_text
                text = extract_text(content, "application/pdf")
            elif ct.startswith("text/"):
                text = content.decode("utf-8", errors="replace")
            else:
                logger.info("Skipping URL with unsupported content-type: %s (%s)", url, ct)
                return None
            return text, ct
    except (httpx.HTTPError, OSError) as e:
        logger.warning("URL fetch failed: %s — %s", url, e)
        return None


async def ingest_urls_silently(
    redis: Redis,
    user_id: str,
    urls: list[str],
) -> int:
    """
    Fetch each URL, extract+chunk+embed, and enqueue index_document requests
    to the orchestrator's data-gateway worker.

    Returns the count of URLs successfully ingested. Failures are logged but
    do NOT raise — silent ingest must never break the chat flow.
    """
    safe_urls = [u for u in urls if _is_safe(u)]
    if not safe_urls:
        return 0

    from src.embeddings.pipeline import EmbeddingPipeline, RecursiveCharacterSplitter

    pipeline = EmbeddingPipeline()
    splitter = RecursiveCharacterSplitter()

    ingested = 0
    for url in safe_urls:
        try:
            fetched = await _fetch(url)
            if not fetched:
                continue
            text, ct = fetched
            if not text.strip():
                continue

            chunks = splitter.split_text(text)
            if not chunks:
                continue

            embeddings = await pipeline.embed_batch(chunks)
            doc_id = _doc_id_for(url)
            filename = url[:200]  # truncate to fit OpenSearch keyword field

            for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
                index_request = {
                    "action": "index_document",
                    "user_id": user_id,
                    "chunk": {
                        "id": f"{user_id}/{doc_id}-chunk-{i}",
                        "docType": "url",
                        "content": chunk_text,
                        "contentVector": embedding,
                        "filename": filename,
                        "pageNumber": 0,
                        "chunkIndex": i,
                        "uploadedAt": datetime.now(timezone.utc).isoformat(),
                        "sourceUrl": url,
                    },
                }
                await redis.lpush(
                    "queue:orchestrator:data_gateway",
                    json.dumps(index_request),
                )

            logger.info(
                "URL ingested silently: %s -> %d chunks (user=%s)",
                url, len(chunks), user_id,
            )
            ingested += 1
            # Clear the no_docs RAG cache so the next query can find this URL
            try:
                await redis.delete(f"cache:no_docs:{user_id}")
            except Exception:
                pass
        except Exception as e:  # noqa: BLE001 — never break the chat flow
            logger.error("URL silent-ingest failed for %s: %s", url, e)

    return ingested


def schedule_silent_ingest(redis: Redis, user_id: str, text: str) -> asyncio.Task | None:
    """
    Scan `text` for URLs and kick off background ingest. Returns the asyncio
    Task so the caller can await it in tests; in production it is fire-and-forget.
    Returns None if no URLs found.
    """
    urls = extract_urls(text)
    if not urls:
        return None
    return asyncio.create_task(ingest_urls_silently(redis, user_id, urls))
