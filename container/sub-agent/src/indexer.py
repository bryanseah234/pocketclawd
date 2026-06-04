"""
NanoClaw Indexer -- dedicated document indexing worker.

Runs as a separate ECS task (nanoclaw-indexer) from the same image as the
sub-agent, with a different entrypoint (``python -m src.indexer``). Its single
job is to take a file that has landed in S3, extract its text, chunk + embed it,
and push the chunks to the orchestrator's DataGateway queue for AOSS indexing.

Why a separate process (Wave 5):
    Previously ``document_upload`` messages shared the ``queue:agent:dispatch``
    queue with user chat messages, so indexing a large PDF blocked a user's
    conversation (head-of-line blocking on a 2-worker pool). The indexer pulls
    from its own queue (``queue:orchestrator:indexing``) so the two workloads
    never contend.

Queue contract:
    Inbound:   queue:orchestrator:indexing      (BRPOP)
    Chunks:    queue:orchestrator:data_gateway  (LPUSH, action=index_document)
    Notices:   queue:orchestrator:responses     (LPUSH, user completion/failure)

Isolation note:
    The userId used to index MUST be the exact canonical id the chat/RAG
    pipeline filters on (``wa:<full-jid>`` / ``tg:<chatId>``), otherwise the
    user can never retrieve their own document. The upload-worker computes this;
    the indexer trusts ``realUserId`` (falling back to the envelope userId).
"""

import asyncio
import json
import logging
import os
import signal
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis

from .config import Settings, get_settings

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("indexer")

INDEXING_QUEUE = "queue:orchestrator:indexing"
DATA_GATEWAY_QUEUE = "queue:orchestrator:data_gateway"
RESPONSES_QUEUE = "queue:orchestrator:responses"

_SUPPORTED_HINT = (
    "PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV, text, HTML, "
    "and images (JPG/PNG/WebP/HEIC/GIF)"
)


class IndexerState:
    def __init__(self) -> None:
        self.settings: Settings = get_settings()
        self.redis: aioredis.Redis | None = None
        self.running: bool = False


state = IndexerState()


async def connect_redis(settings: Settings) -> aioredis.Redis:
    client = aioredis.Redis(
        host=settings.redis.host,
        port=settings.redis.port,
        password=settings.redis.password or None,
        db=settings.redis.db,
        ssl=settings.redis.ssl,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=30,
        retry_on_timeout=True,
    )
    await client.ping()
    return client


async def _notify_user(user_id, channel_type, platform_id, content):
    """Push a user-facing chat message. No-op when channel routing is absent
    (corporate/admin uploads) so they never echo into an unopened chat."""
    if not channel_type or not platform_id or state.redis is None:
        return
    envelope = {
        "id": f"index-notice-{datetime.now(timezone.utc).timestamp()}",
        "userId": user_id,
        "type": "chat",
        "payload": {
            "content": content,
            "channelType": channel_type,
            "platformId": platform_id,
            "threadId": None,
        },
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    await state.redis.lpush(RESPONSES_QUEUE, json.dumps(envelope, ensure_ascii=False))


async def _clear_indexing_flag(user_id):
    if state.redis is None:
        return
    try:
        await state.redis.delete(f"nanoclaw:indexing:{user_id}")
    except Exception as exc:  # pragma: no cover
        logger.warning("Failed to clear indexing flag for %s: %s", user_id, exc)


async def index_file(message: dict) -> None:
    """Download -> extract -> chunk -> embed -> push chunks to DataGateway."""
    import boto3

    payload = message.get("payload", {}) or {}
    envelope_user = message.get("userId", "") or ""
    user_id = payload.get("realUserId") or envelope_user
    filename = payload.get("filename", "unknown")
    content_type = payload.get("contentType", "application/octet-stream")
    s3_key = payload.get("s3Key", "")
    bucket = payload.get("bucket", "") or os.environ.get("DATA_BUCKET", "")
    origin = payload.get("origin", "upload_worker")
    is_corporate = bool(payload.get("corporate"))
    channel_type = payload.get("channelType")
    platform_id = payload.get("platformId")

    logger.info(
        "Indexing file=%s user=%s ct=%s s3=%s corporate=%s",
        filename, user_id, content_type, s3_key, is_corporate,
    )

    if not s3_key or not bucket:
        logger.error("Missing s3Key/bucket; cannot index file=%s", filename)
        await _clear_indexing_flag(user_id)
        await _notify_user(user_id, channel_type, platform_id,
                           f'Sorry, I could not locate "{filename}" to index it. Please try again.')
        return

    try:
        s3 = boto3.client("s3", region_name=state.settings.aws_region)
        obj = s3.get_object(Bucket=bucket, Key=s3_key)
        content = obj["Body"].read()
        logger.info("Downloaded %d bytes from %s/%s", len(content), bucket, s3_key)

        from src.documents.extractors import extract_text, is_supported, resolve_content_type

        # Re-queued files (s3-reindex) and some clients send a generic
        # application/octet-stream. Recover the real type from the filename
        # extension so PDFs/Office docs/images aren't wrongly rejected.
        content_type = resolve_content_type(content_type, filename)
        from src.embeddings.pipeline import EmbeddingPipeline, RecursiveCharacterSplitter

        if not is_supported(content_type):
            logger.warning("Unsupported content type %s for %s", content_type, filename)
            await _clear_indexing_flag(user_id)
            await _notify_user(user_id, channel_type, platform_id,
                               f'I can\'t read "{filename}" (unsupported type). I can handle {_SUPPORTED_HINT}.')
            return

        text = extract_text(content, content_type)
        if not text or not text.strip():
            logger.warning("No text extracted from %s", filename)
            await _clear_indexing_flag(user_id)
            await _notify_user(user_id, channel_type, platform_id,
                               f'I couldn\'t find any readable text in "{filename}".')
            return

        pipeline = EmbeddingPipeline(region=state.settings.aws_region)
        splitter = RecursiveCharacterSplitter()
        chunks = splitter.split_text(text)
        embeddings = await pipeline.embed_batch(chunks)

        for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
            index_request = {
                "action": "index_document",
                "user_id": user_id,
                "origin": origin,
                "chunk": {
                    "id": f"{user_id}/{filename}-chunk-{i}",
                    "docType": content_type.split("/")[-1],
                    "content": chunk_text,
                    "contentVector": embedding,
                    "filename": filename,
                    "s3Key": s3_key,
                    "pageNumber": 0,
                    "chunkIndex": i,
                    "uploadedAt": datetime.now(timezone.utc).isoformat(),
                },
            }
            await state.redis.lpush(DATA_GATEWAY_QUEUE, json.dumps(index_request))

        # Clear the per-user "no docs" short-circuit cache so the very next
        # question routes through RAG retrieval instead of skipping it. Without
        # this, a stale 5-min no_docs flag (set before this upload) makes the
        # agent answer "I don't see a document" right after a successful index.
        try:
            await state.redis.delete(f"cache:no_docs:{user_id}")
        except Exception as _cache_err:
            logger.warning("Could not clear no_docs cache for %s: %s", user_id, _cache_err)

        if not is_corporate and "/staging/" in s3_key:
            # Canonical documents location is `<userId>/documents/<filename>` (bare
            # userId, NO `users/` prefix) -- this is where the admin dashboard lists
            # (src/cloud/admin-dashboard/index.ts `${uid}/documents/`) and where the
            # dashboard upload path writes. Channel staging keys carry an extra
            # `users/` segment + `<uploadId>/`, so derive the bare-userId target
            # explicitly rather than string-swapping the prefix.
            documents_key = f"{user_id}/documents/{filename}"
            try:
                # TaggingDirective=REPLACE with no Tagging drops the source's
                # `lifecycle=staging-24h` tag so the moved object is NOT auto-expired
                # by the 24h staging lifecycle rule. (Also: copying the source tag
                # would require s3:PutObjectTagging and previously failed with
                # AccessDenied -- see infrastructure/terraform/ecs.tf.)
                s3.copy_object(Bucket=bucket,
                               CopySource={"Bucket": bucket, "Key": s3_key},
                               Key=documents_key,
                               TaggingDirective="REPLACE",
                               Tagging="")
                s3.delete_object(Bucket=bucket, Key=s3_key)
                logger.info("Moved %s -> %s", s3_key, documents_key)
            except Exception as move_err:
                logger.warning("Staging->documents move failed: %s", move_err)

        logger.info("Indexed %s (%d chunks) for user=%s", filename, len(chunks), user_id)
        await _clear_indexing_flag(user_id)
        await _notify_user(user_id, channel_type, platform_id,
                           f'Done -- "{filename}" is indexed. Ask me anything about it.')

    except Exception as exc:
        logger.error("Indexing failed for %s: %s", filename, exc, exc_info=True)
        await _clear_indexing_flag(user_id)
        await _notify_user(user_id, channel_type, platform_id,
                           f'Sorry, something went wrong indexing "{filename}". Please try again.')


async def poll_loop() -> None:
    logger.info("Indexer poll loop started on key=%s", INDEXING_QUEUE)
    timeout = state.settings.agent.queue_poll_timeout
    while state.running:
        try:
            if state.redis is None:
                await asyncio.sleep(2)
                continue
            result = await state.redis.brpop(INDEXING_QUEUE, timeout=timeout)
            if result is None:
                continue
            _key, raw = result
            try:
                message = json.loads(raw)
            except (json.JSONDecodeError, ValueError) as exc:
                logger.error("Unparseable indexer message dropped: %s", exc)
                continue
            try:
                await asyncio.wait_for(index_file(message), timeout=300.0)
            except asyncio.TimeoutError:
                payload = message.get("payload", {}) or {}
                uid = payload.get("realUserId") or message.get("userId", "")
                logger.error("index_file timed out for user=%s", uid)
                await _clear_indexing_flag(uid)
                await _notify_user(uid, payload.get("channelType"), payload.get("platformId"),
                                   "Sorry, that file took too long to index. Try a smaller file?")
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Indexer loop error: %s", exc, exc_info=True)
            await asyncio.sleep(2)
    logger.info("Indexer poll loop stopped")


async def main() -> None:
    state.settings = get_settings()
    state.redis = await connect_redis(state.settings)
    state.running = True

    loop = asyncio.get_running_loop()

    def _stop() -> None:
        logger.info("Shutdown signal received")
        state.running = False

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _stop)
        except NotImplementedError:  # pragma: no cover
            pass

    try:
        await poll_loop()
    finally:
        if state.redis is not None:
            await state.redis.aclose()


if __name__ == "__main__":
    asyncio.run(main())
