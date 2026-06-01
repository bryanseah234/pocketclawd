"""
NanoClaw Sub-Agent — FastAPI application.

Runs inside a per-user Docker container. Communicates with the orchestrator
exclusively via Redis queues:
  - Inbound:  queue:agent:{userId}:inbound  (BRPOP to receive)
  - Outbound: queue:orchestrator:responses   (LPUSH to send)

The main loop polls the inbound queue, processes each message, and enqueues
the response for the orchestrator to deliver via WhatsApp.
"""

import asyncio
import json
import os
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .config import Settings, get_settings
from .reminders import parse_remind_command, list_reminders, cancel_reminder, reminder_delivery_loop

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Debug-mode error reporting
# ---------------------------------------------------------------------------
import hashlib as _hashlib

_DEBUG_MODE = os.environ.get("CLAWD_DEBUG", "").lower() in ("1", "true", "yes")


def _error_ref(exc: Exception, message_id: str) -> str:
    """Generate a short error reference code for user reporting."""
    raw = f"{type(exc).__name__}:{message_id}"
    return _hashlib.sha1(raw.encode()).hexdigest()[:8].upper()


def _user_error_message(exc: Exception, message_id: str, context: str = "chat") -> str:
    """
    Return the message sent to the user when something fails.
    - Normal mode : friendly one-liner
    - Debug mode  : error type + ref code so user can report to admin
    """
    if not _DEBUG_MODE:
        if context == "timeout":
            return "Sorry, that took too long on my end. Can you try again? 🙏"
        return "Hmm, something went wrong on my end. Try again in a moment? 🙏"

    ref = _error_ref(exc, message_id)
    err_type = type(exc).__name__
    # Short human hint by exception class
    hints = {
        "ClientError": "AWS service error (Bedrock / DynamoDB / S3)",
        "TimeoutError": "Request timed out — service may be slow",
        "asyncio.TimeoutError": "Processing timed out (45s limit hit)",
        "ValidationException": "Model rejected the request (content or format)",
        "ThrottlingException": "Rate limit hit — try again in a moment",
        "ServiceUnavailableException": "AWS Bedrock temporarily unavailable",
        "ResponseError": "OpenSearch query failed",
        "JSONDecodeError": "Unexpected response format from a service",
        "httpx.ConnectError": "Could not reach external service (network)",
        "httpx.ReadTimeout": "External service timed out",
    }
    hint = hints.get(err_type, err_type)
    return (
        "⚠️ *Error* `[" + ref + "]`\n"
        "_" + hint + "_\n\n"
        "Screenshot this and send to admin with ref `" + ref + "`."
    )


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class InboundMessage(BaseModel):
    """Message received from the orchestrator via Redis queue."""

    message_id: str
    user_id: str
    content: str
    timestamp: str
    metadata: dict[str, Any] = {}


class AgentResponse(BaseModel):
    """Response sent back to the orchestrator via Redis queue."""

    message_id: str
    user_id: str
    content: str
    timestamp: str
    metadata: dict[str, Any] = {}


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    user_id: str
    redis_connected: bool
    uptime_seconds: float
    version: str


class ProcessRequest(BaseModel):
    """Direct message processing request (used for testing/admin)."""

    content: str
    metadata: dict[str, Any] = {}


class ProcessResponse(BaseModel):
    """Direct message processing response."""

    content: str
    metadata: dict[str, Any] = {}


# ---------------------------------------------------------------------------
# Application state
# ---------------------------------------------------------------------------


class AppState:
    """Mutable application state shared across the lifespan."""

    def __init__(self) -> None:
        self.settings: Settings = get_settings()
        self.redis: aioredis.Redis | None = None
        self.started_at: datetime = datetime.now(timezone.utc)
        self.poll_task: asyncio.Task[None] | None = None
        self.running: bool = False


state = AppState()


# ---------------------------------------------------------------------------
# Redis helpers
# ---------------------------------------------------------------------------


async def connect_redis(settings: Settings) -> aioredis.Redis:
    """Create and verify a Redis connection."""
    client = aioredis.Redis(
        host=settings.redis.host,
        port=settings.redis.port,
        password=settings.redis.password or None,
        db=settings.redis.db,
        ssl=settings.redis.ssl,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=30,  # must exceed queue_poll_timeout (5s) plus network slack
        retry_on_timeout=True,
    )
    await client.ping()
    return client


async def enqueue_response(response: AgentResponse) -> None:
    """Push a response onto the orchestrator's response queue.

    Translates the sub-agent's internal AgentResponse shape into the
    orchestrator's expected QueueMessage-shaped envelope:
      {id, userId, type, payload: {channelType, platformId, threadId, kind, content, ...}, timestamp}

    Routing fields (channelType/platformId/threadId/kind) are echoed back from
    the inbound message metadata. Without this echo, the host's startResponsePoll
    would see undefined routing fields and silently drop the response.
    """
    if state.redis is None:
        raise RuntimeError("Redis not connected")
    md = response.metadata or {}
    payload_obj = {
        "content": response.content,
        "channelType": md.get("channelType"),
        "platformId": md.get("platformId"),
        "threadId": md.get("threadId"),
        "kind": md.get("kind", "chat"),
        "metadata": md,
        # Surface "silent" at top-level so the host's suppression check works
        # without having to reach into metadata.
        "silent": bool(md.get("silent")) or response.content == "",
    }
    envelope = {
        "id": response.message_id,
        "userId": response.user_id,
        "type": md.get("type", "chat"),
        "payload": payload_obj,
        "timestamp": response.timestamp,
    }
    payload = json.dumps(envelope, ensure_ascii=False)
    await state.redis.lpush(state.settings.response_queue_key, payload)
    logger.info(
        "Enqueued response for message_id=%s user_id=%s channelType=%s platformId=%s silent=%s",
        response.message_id,
        response.user_id,
        payload_obj.get("channelType"),
        payload_obj.get("platformId"),
        payload_obj["silent"],
    )


# ---------------------------------------------------------------------------
# Message processing
# ---------------------------------------------------------------------------


async def process_message(message: InboundMessage) -> AgentResponse:
    """
    Process a single inbound message and produce a response.

    Routes messages by type:
      - document_upload: extract → chunk → embed → index via DataGateway
      - chat (default): placeholder for LLM + RAG pipeline

    For document_upload messages, the metadata contains:
      - filename, contentType, s3Key, bucket, uploadId
    """
    logger.info(
        "Processing message_id=%s type=%s from user_id=%s",
        message.message_id,
        message.metadata.get("type", "chat"),
        message.user_id,
    )

    msg_type = message.metadata.get("type", "chat")

    if msg_type == "document_upload":
        return await _handle_document_upload(message)

    # Check PDPA consent before any chat processing
    from src.consent import needs_consent, handle_consent_response, CONSENT_MESSAGE
    if state.redis is not None:
        in_consent = await needs_consent(state.redis, message.user_id)
        if in_consent:
            # Check if this message is a consent response
            granted, reply = await handle_consent_response(state.redis, message.user_id, message.content)
            if granted is None and reply == "":
                # Fresh user — send consent message
                return AgentResponse(
                    message_id=message.message_id,
                    user_id=message.user_id,
                    content=CONSENT_MESSAGE,
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    metadata={"source": "sub-agent", "type": "consent_request"},
                )
            if granted is False:
                return AgentResponse(
                    message_id=message.message_id,
                    user_id=message.user_id,
                    content=reply,
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    metadata={"source": "sub-agent", "type": "consent_declined"},
                )
            if granted is None:
                return AgentResponse(
                    message_id=message.message_id,
                    user_id=message.user_id,
                    content=reply,
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    metadata={"source": "sub-agent", "type": "consent_pending"},
                )
            # granted=True — fall through to normal processing

        # Discovery / onboarding (only after consent, skip for document_upload)
        if msg_type != "document_upload" and state.redis is not None:
            from src.persona import discovery_skill
            disc_state = await discovery_skill.load_state(state.redis, message.user_id)
            # Allow escape slash commands during onboarding
            _is_escape_cmd = message.content.lstrip().startswith('/') and any(
                message.content.lstrip().lower().startswith(cmd)
                for cmd in ('/forget', '/help', '/privacy', '/about', '/connect', '/disconnect', '/integrations')
            )
            if disc_state is not None and not discovery_skill.is_complete(disc_state) and not _is_escape_cmd:
                # User is mid-onboarding
                complete, reply_msg, disc_state = await discovery_skill.handle_response(
                    state.redis, disc_state, message.content
                )
                if reply_msg:
                    return AgentResponse(
                        message_id=message.message_id,
                        user_id=message.user_id,
                        content=reply_msg,
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        metadata={"source": "sub-agent", "type": "onboarding"},
                    )
            elif not _is_escape_cmd:
                # Check if brand new user (skip for escape slash commands)
                from src.persona.preference_probe import probe_user_preferences
                persona_ctx = await probe_user_preferences(state.redis, message.user_id)
                if persona_ctx.is_new_user:
                    disc_state, first_q = discovery_skill.activate(message.user_id, message.content)
                    await discovery_skill.save_state(state.redis, disc_state)
                    return AgentResponse(
                        message_id=message.message_id,
                        user_id=message.user_id,
                        content=first_q,
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        metadata={"source": "sub-agent", "type": "onboarding"},
                    )

        # Rate limiting (only after consent granted)
        from src.rate_limiter import RateLimiter
        rate_limiter = RateLimiter(state.redis)
        allowed, rate_reason = await rate_limiter.check_and_record(message.user_id)
        if not allowed:
            return AgentResponse(
                message_id=message.message_id,
                user_id=message.user_id,
                content=f"⚠️ {rate_reason}. Please wait a moment before sending another message.",
                timestamp=datetime.now(timezone.utc).isoformat(),
                metadata={"source": "sub-agent", "type": "rate_limited"},
            )

        # Slash command handling
        from src.commands import handle_command
        command_response = await handle_command(state.redis, message.user_id, message.content)
        if command_response is not None:
            return AgentResponse(
                message_id=message.message_id,
                user_id=message.user_id,
                content=command_response,
                timestamp=datetime.now(timezone.utc).isoformat(),
                metadata={"source": "sub-agent", "type": "command"},
            )

    # Load user profile (from discovery_skill redis state or preference_probe)
    user_profile: dict = {}
    if state.redis is not None:
        try:
            from src.persona import discovery_skill as _ds
            _disc = await _ds.load_state(state.redis, message.user_id)
            if _disc and _ds.is_complete(_disc):
                from src.persona.discovery_skill import USE_LABELS
                use_num = _disc.primary_use or ""
                user_profile = {
                    "display_name": _disc.user_name or "",
                    "use_case": USE_LABELS.get(use_num, use_num),
                    "reply_style": _disc.reply_style or "",
                }
        except Exception:
            pass

    # Chat message — use RAG pipeline (embed → search → LLM)
    return await _handle_chat_message(message, user_profile=user_profile)


async def _handle_chat_message(message: InboundMessage, user_profile: dict | None = None) -> AgentResponse:
    """
    Handle a chat message: history → RAG → LLM → respond.
    Optimised for <5s end-to-end via parallel history+embed and fire-and-forget store.
    """
    import time as _time
    from src.rag.pipeline import RAGPipeline

    _t0 = _time.monotonic()

    try:
        if state.redis is None:
            raise RuntimeError("Redis not connected")

        pipeline = RAGPipeline(
            redis_client=state.redis,
            user_id=message.user_id,
            region=state.settings.aws_region,
        )

        # Step 1: Chat history + user-message store IN PARALLEL (fire-and-forget store)
        _t1 = _time.monotonic()
        chat_history = await _get_chat_history(message.user_id)
        logger.info("PERF history=%.2fs user=%s", _time.monotonic() - _t1, message.user_id)

        # Store user message fire-and-forget (don't block pipeline on it)
        asyncio.ensure_future(_store_chat_message(message.user_id, "user", message.content))

        # Silent URL ingestion (non-blocking)
        try:
            from src.url_ingestion import schedule_silent_ingest
            schedule_silent_ingest(state.redis, message.user_id, message.content)
        except Exception as url_err:
            logger.warning("URL silent-ingest scheduling failed: %s", url_err)

        # Step 2: RAG pipeline (embed + search + LLM)
        _t2 = _time.monotonic()
        response_text = await pipeline.query(
            user_message=message.content,
            chat_history=chat_history,
            user_profile=user_profile,
        )
        logger.info("PERF rag_total=%.2fs user=%s", _time.monotonic() - _t2, message.user_id)
        logger.info("PERF total=%.2fs user=%s", _time.monotonic() - _t0, message.user_id)

        # Store assistant response fire-and-forget
        asyncio.ensure_future(_store_chat_message(message.user_id, "assistant", response_text))

        return AgentResponse(
            message_id=message.message_id,
            user_id=message.user_id,
            content=response_text,
            timestamp=datetime.now(timezone.utc).isoformat(),
            metadata={"source": "sub-agent", "type": "chat", "processed": True},
        )

    except Exception as e:
        logger.error(
            "Chat processing failed for user_id=%s: %s",
            message.user_id, str(e), exc_info=True,
        )
        return AgentResponse(
            message_id=message.message_id,
            user_id=message.user_id,
            content="Hmm, something went wrong on my end. Try again in a sec?",
            timestamp=datetime.now(timezone.utc).isoformat(),
            metadata={"source": "sub-agent", "type": "chat", "error": str(e)},
        )


async def _get_chat_history(user_id: str) -> list[dict[str, Any]]:
    """Fetch last 100 messages from DynamoDB via orchestrator Redis queue."""
    if state.redis is None:
        return []

    import secrets as sec
    request_id = sec.token_hex(8)
    # Use Redis LRU cache first (5min TTL) to avoid DynamoDB round-trip on every message
    cache_key = f"cache:chat_history:{user_id}"
    cached = await state.redis.get(cache_key)
    if cached:
        try:
            return json.loads(cached)
        except Exception:
            pass

    request = {
        "action": "get_chat_history",
        "request_id": request_id,
        "user_id": user_id,
        "limit": 100,  # last 100 messages of context
    }
    await state.redis.lpush("queue:orchestrator:data_gateway", json.dumps(request))

    response_key = f"queue:agent:{user_id}:dg_response:{request_id}"
    result = await state.redis.brpop(response_key, timeout=3)  # 3s max (was 5)

    if result is None:
        return []

    _key, raw = result
    response = json.loads(raw)
    msgs = response.get("messages", [])
    # Cache for 5 minutes
    try:
        await state.redis.setex(cache_key, 300, json.dumps(msgs))
    except Exception:
        pass
    return msgs


async def _store_chat_message(user_id: str, role: str, content: str) -> None:
    """Store a chat message in DynamoDB via orchestrator Redis queue (fire-and-forget)."""
    if state.redis is None:
        return

    request = {
        "action": "put_chat_message",
        "user_id": user_id,
        "message": {
            "messageId": f"{role}-{datetime.now(timezone.utc).timestamp():.0f}",
            "role": role,
            "content": content,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    }
    await state.redis.lpush("queue:orchestrator:data_gateway", json.dumps(request))
    # Invalidate history cache so next fetch gets fresh data
    try:
        await state.redis.delete(f"cache:chat_history:{user_id}")
    except Exception:
        pass


async def _handle_document_upload(message: InboundMessage) -> AgentResponse:
    """
    Handle a document_upload message: download from S3, extract text,
    chunk, embed, and index into OpenSearch via the orchestrator's DataGateway.
    """
    import boto3

    metadata = message.metadata
    filename = metadata.get("filename", "unknown")
    content_type = metadata.get("contentType", "application/octet-stream")
    s3_key = metadata.get("s3Key", "")
    bucket = metadata.get("bucket", "")
    upload_id = metadata.get("uploadId", "")

    logger.info(
        "Document upload: filename=%s content_type=%s s3_key=%s",
        filename,
        content_type,
        s3_key,
    )

    try:
        # Step 1: Download file from S3
        s3_client = boto3.client("s3", region_name=state.settings.aws_region)
        response = s3_client.get_object(Bucket=bucket, Key=s3_key)
        content = response["Body"].read()

        logger.info("Downloaded %d bytes from S3: %s/%s", len(content), bucket, s3_key)

        # Step 2: Process document (extract → chunk → embed)
        from src.documents.processor import DocumentProcessor
        from src.embeddings.pipeline import EmbeddingPipeline

        pipeline = EmbeddingPipeline(region=state.settings.aws_region)
        processor = DocumentProcessor(pipeline, user_id=message.user_id)
        result = await processor.process_document(filename, content, content_type)

        if result.status == "failed":
            logger.warning(
                "Document processing failed: %s (error: %s)",
                filename,
                result.error,
            )
            return AgentResponse(
                message_id=message.message_id,
                user_id=message.user_id,
                content=f"❌ Failed to process '{filename}': {result.error}",
                timestamp=datetime.now(timezone.utc).isoformat(),
                metadata={
                    "source": "sub-agent",
                    "type": "document_processed",
                    "status": "failed",
                    "uploadId": upload_id,
                },
            )

        # Step 3: Index chunks into OpenSearch via orchestrator DataGateway queue
        from src.documents.extractors import extract_text as do_extract
        from src.embeddings.pipeline import RecursiveCharacterSplitter

        splitter = RecursiveCharacterSplitter()
        text = do_extract(content, content_type)
        chunks = splitter.split_text(text)
        embeddings = await pipeline.embed_batch(chunks)

        # Send indexing requests to orchestrator via Redis
        if state.redis is not None:
            for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
                chunk_id = f"{message.user_id}/{filename}-chunk-{i}"
                index_request = {
                    "action": "index_document",
                    "user_id": message.user_id,
                    "origin": metadata.get("origin", "upload_worker"),
                    "chunk": {
                        "id": chunk_id,
                        "docType": content_type.split("/")[-1],
                        "content": chunk_text,
                        "contentVector": embedding,
                        "filename": filename,
                        "pageNumber": 0,
                        "chunkIndex": i,
                        "uploadedAt": datetime.now(timezone.utc).isoformat(),
                    },
                }
                await state.redis.lpush(
                    "queue:orchestrator:data_gateway",
                    json.dumps(index_request),
                )

        # Step 4: Move file from staging to documents prefix
        documents_key = f"{message.user_id}/documents/{filename}"
        try:
            s3_client.copy_object(
                Bucket=bucket,
                CopySource={"Bucket": bucket, "Key": s3_key},
                Key=documents_key,
            )
            s3_client.delete_object(Bucket=bucket, Key=s3_key)
            logger.info("Moved file from staging to documents: %s", documents_key)
        except Exception as move_err:
            logger.warning("Failed to move file from staging: %s", move_err)

        logger.info(
            "Document processed successfully: %s (%d chunks, %d tokens)",
            filename,
            result.chunk_count,
            result.total_tokens,
        )

        # Per Q5 (silent admin uploads): if origin='upload_worker', the message
        # came from the admin dashboard, not a user DM. Return a minimal/silent
        # response so we do not echo into a user chat the admin never opened.
        origin = metadata.get("origin")
        if origin == "upload_worker":
            return AgentResponse(
                message_id=message.message_id,
                user_id=message.user_id,
                content="",  # silent: not delivered to chat
                timestamp=datetime.now(timezone.utc).isoformat(),
                metadata={
                    "source": "sub-agent",
                    "type": "document_processed",
                    "status": "success",
                    "uploadId": upload_id,
                    "chunks": result.chunk_count,
                    "tokens": result.total_tokens,
                    "silent": True,
                },
            )

        return AgentResponse(
            message_id=message.message_id,
            user_id=message.user_id,
            content=(
                f"✅ Document '{filename}' processed successfully.\n"
                f"📊 {result.chunk_count} chunks indexed ({result.total_tokens} tokens).\n"
                f"You can now ask questions about this document."
            ),
            timestamp=datetime.now(timezone.utc).isoformat(),
            metadata={
                "source": "sub-agent",
                "type": "document_processed",
                "status": "success",
                "uploadId": upload_id,
                "chunkCount": result.chunk_count,
                "totalTokens": result.total_tokens,
            },
        )

    except Exception as e:
        logger.error(
            "Document upload processing failed: %s (error: %s)",
            filename,
            str(e),
            exc_info=True,
        )
        return AgentResponse(
            message_id=message.message_id,
            user_id=message.user_id,
            content=f"❌ Error processing '{filename}': {str(e)}",
            timestamp=datetime.now(timezone.utc).isoformat(),
            metadata={
                "source": "sub-agent",
                "type": "document_processed",
                "status": "failed",
                "uploadId": upload_id,
                "error": str(e),
            },
        )


# ---------------------------------------------------------------------------
# Queue polling loop
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Inbound read abstraction — list (BRPOP) vs stream (XREADGROUP) (t2-8)
# ---------------------------------------------------------------------------

# Flag-gated at-least-once delivery. When REDIS_STREAMS_ENABLED=true the loop
# reads via a consumer group and only acks after successful processing, so a
# worker crash mid-message leaves it claimable instead of lost. Default off
# keeps the exact prior BRPOP behavior (non-breaking rollback = flag flip).
_STREAMS_ENABLED = os.environ.get("REDIS_STREAMS_ENABLED", "false") == "true"
_STREAM_GROUP = os.environ.get("REDIS_STREAM_GROUP", "subagents")
_STREAM_CONSUMER = os.environ.get(
    "REDIS_STREAM_CONSUMER", os.environ.get("HOSTNAME", "worker")
)


def _stream_key_for(list_key: str) -> str:
    """Map a list queue key to its distinct stream keyspace.

    queue:agent:dispatch          -> stream:agent:dispatch
    queue:agent:{u}:inbound       -> stream:agent:{u}:inbound
    """
    return list_key.replace("queue:agent:", "stream:agent:", 1)


async def _ensure_group(stream_key: str) -> None:
    try:
        await state.redis.xgroup_create(
            name=stream_key, groupname=_STREAM_GROUP, id="$", mkstream=True
        )
    except Exception as e:  # noqa: BLE001
        if "BUSYGROUP" not in str(e):
            raise


async def _read_inbound(queue_key: str, timeout: int):
    """Read one inbound message.

    Returns (raw_payload: str, ack: Callable[[], Awaitable[None]]) or None on
    timeout. In list mode ack is a no-op; in stream mode ack XACKs the entry.
    """
    if not _STREAMS_ENABLED:
        result = await state.redis.brpop(queue_key, timeout=timeout)
        if result is None:
            return None
        _key, raw_payload = result

        async def _noop_ack() -> None:
            return None

        return raw_payload, _noop_ack

    # Streams mode
    stream_key = _stream_key_for(queue_key)
    await _ensure_group(stream_key)
    resp = await state.redis.xreadgroup(
        groupname=_STREAM_GROUP,
        consumername=_STREAM_CONSUMER,
        streams={stream_key: ">"},
        count=1,
        block=timeout * 1000,
    )
    if not resp:
        return None
    # resp = [(stream_key, [(entry_id, {field: value}), ...])]
    _sk, entries = resp[0]
    if not entries:
        return None
    entry_id, fields = entries[0]
    raw_payload = fields.get("data") or fields.get(b"data")
    if isinstance(raw_payload, bytes):
        raw_payload = raw_payload.decode("utf-8")

    async def _ack_entry() -> None:
        try:
            await state.redis.xack(stream_key, _STREAM_GROUP, entry_id)
        except Exception as ack_err:  # noqa: BLE001
            logger.warning("XACK failed for %s: %s", entry_id, ack_err)

    return raw_payload, _ack_entry


async def poll_queue() -> None:
    """
    Main loop: BRPOP from the inbound Redis queue, process each message,
    and LPUSH the response to the orchestrator's response queue.

    Runs as a background task for the lifetime of the application.
    """
    settings = state.settings
    queue_key = settings.inbound_queue_key
    timeout = settings.agent.queue_poll_timeout

    logger.info("Starting queue poll loop on key=%s timeout=%ds", queue_key, timeout)

    while state.running:
        try:
            if state.redis is None:
                logger.warning("Redis not connected, waiting before retry...")
                await asyncio.sleep(2)
                continue

            # Read one message. In Streams mode (REDIS_STREAMS_ENABLED=true)
            # this uses XREADGROUP and returns an ack closure that XACKs the
            # entry only after successful processing (at-least-once, t2-8). In
            # the default list mode it uses BRPOP and ack is a no-op (the
            # message is already removed by the pop — unchanged behavior).
            read = await _read_inbound(queue_key, timeout)
            if read is None:
                # Timeout — no message available, loop again
                continue

            raw_payload, _ack = read
            logger.debug("Received raw payload from queue: %s", raw_payload[:200])

            try:
                data = json.loads(raw_payload)
                payload_dict = data.get("payload", {}) or {}
                # Derive REAL user_id from platformId when AGENT_USER_ID="shared".
                # WhatsApp platformId is e.g. "6597901331@s.whatsapp.net" — we
                # use the bare phone number as the per-user partition key for
                # rate limiting, chat history, RAG, and S3 prefixes.
                # Per-user architecture: envelope userId IS the real user id.
                # The orchestrator enqueues to queue:agent:{userId}:inbound
                # and this container is started with AGENT_USER_ID={userId}.
                envelope_user = data.get("userId", "")
                platform_id = payload_dict.get("platformId", "")
                # Fallback: if userId is missing/empty, derive from platformId
                if envelope_user and envelope_user not in ("", "shared", "anon", "dispatch"):
                    real_user = envelope_user
                elif platform_id:
                    real_user = str(platform_id).split("@")[0]
                elif payload_dict.get("realUserId"):
                    real_user = str(payload_dict["realUserId"])
                else:
                    real_user = state.settings.agent.user_id or envelope_user
                # Stash original envelope userId for reference, but use real_user
                # as the addressing key for all downstream calls.
                merged_meta = {
                    "type": data.get("type", "chat"),
                    "envelopeUserId": envelope_user,
                    **payload_dict,
                }
                message = InboundMessage(
                    message_id=data.get("id", ""),
                    user_id=real_user or envelope_user,
                    content=payload_dict.get("content", data.get("content", "")),
                    timestamp=data.get("timestamp", ""),
                    metadata=merged_meta,
                )
            except (json.JSONDecodeError, ValueError) as e:
                logger.error("Failed to parse inbound message: %s", e)
                # Poison message — ack so Streams mode drops it rather than
                # redelivering an unparseable entry forever.
                await _ack()
                continue

            # Process with timeout — 45s hard cap so hung LLM never blocks the queue
            _retry_count = int(data.get("_retry", 0))
            _MAX_RETRIES = 2
            try:
                response = await asyncio.wait_for(process_message(message), timeout=45.0)
            except asyncio.TimeoutError:
                logger.error("Message %s timed out after 45s (retry %d)", message.message_id, _retry_count)
                if _retry_count < _MAX_RETRIES:
                    # Re-enqueue with incremented retry counter
                    retry_payload = json.loads(raw_payload)
                    retry_payload["_retry"] = _retry_count + 1
                    await state.redis.lpush(queue_key, json.dumps(retry_payload))
                    logger.warning("Re-enqueued message %s (retry %d)", message.message_id, _retry_count + 1)
                else:
                    # Send fallback response + move to DLQ
                    await state.redis.lpush(
                        f"queue:agent:{real_user}:dlq",
                        raw_payload,
                    )
                    logger.error("Message %s moved to DLQ after %d retries", message.message_id, _MAX_RETRIES)
                    # Send user a fallback so they aren't left hanging
                    response = AgentResponse(
                        message_id=message.message_id,
                        user_id=message.user_id,
                        content=_user_error_message(asyncio.TimeoutError(), message.message_id, "timeout"),
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        metadata={"source": "sub-agent", "type": "error"},
                    )
                    for _k in ("channelType", "platformId", "threadId", "kind", "adminTestMessageId"):
                        if _k in message.metadata and not response.metadata.get(_k):
                            response.metadata[_k] = message.metadata[_k]
                    await enqueue_response(response)
                # Handled (re-enqueued or DLQ'd) — ack so Streams mode does not
                # redeliver from the PEL.
                await _ack()
                continue
            except Exception as proc_err:
                logger.error("process_message failed for %s: %s", message.message_id, proc_err, exc_info=True)
                if _retry_count < _MAX_RETRIES:
                    retry_payload = json.loads(raw_payload)
                    retry_payload["_retry"] = _retry_count + 1
                    await state.redis.lpush(queue_key, json.dumps(retry_payload))
                else:
                    await state.redis.lpush(f"queue:agent:{real_user}:dlq", raw_payload)
                    response = AgentResponse(
                        message_id=message.message_id,
                        user_id=message.user_id,
                        content=_user_error_message(proc_err, message.message_id, "chat"),
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        metadata={"source": "sub-agent", "type": "error"},
                    )
                    for _k in ("channelType", "platformId", "threadId", "kind", "adminTestMessageId"):
                        if _k in message.metadata and not response.metadata.get(_k):
                            response.metadata[_k] = message.metadata[_k]
                    await enqueue_response(response)
                await _ack()
                continue

            # Echo routing fields from inbound -> response metadata so
            # the orchestrator's response poll can deliver back to the
            # right channel/user. Handlers may override by setting the
            # field explicitly in their own metadata dict.
            for _k in ("channelType", "platformId", "threadId", "kind", "adminTestMessageId"):
                if _k in message.metadata and not response.metadata.get(_k):
                    response.metadata[_k] = message.metadata[_k]
            await enqueue_response(response)

            # At-least-once ack (t2-8): in Streams mode this XACKs the entry so
            # it leaves the pending list now that processing fully succeeded. In
            # list mode _ack is a no-op.
            await _ack()

        except aioredis.ConnectionError as e:
            logger.error("Redis connection lost: %s. Reconnecting in 5s...", e)
            await asyncio.sleep(5)
            try:
                state.redis = await connect_redis(settings)
                logger.info("Redis reconnected successfully")
            except Exception as reconnect_err:
                logger.error("Redis reconnection failed: %s", reconnect_err)

        except asyncio.CancelledError:
            logger.info("Poll loop cancelled, shutting down")
            break

        except Exception as e:
            logger.error("Unexpected error in poll loop: %s", e, exc_info=True)
            await asyncio.sleep(1)

    logger.info("Queue poll loop stopped")


# ---------------------------------------------------------------------------
# FastAPI lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    """Manage application startup and shutdown."""
    # Startup
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    logger.info(
        "Starting sub-agent for user_id=%s", state.settings.agent.user_id or "(unset)"
    )

    # Connect to Redis
    try:
        state.redis = await connect_redis(state.settings)
        logger.info("Redis connected at %s:%d", state.settings.redis.host, state.settings.redis.port)
    except Exception as e:
        logger.warning("Redis connection failed at startup: %s (will retry in poll loop)", e)

    # Start the background polling loop
    state.running = True
    state.poll_task = asyncio.create_task(poll_queue())
    state.reminder_task = asyncio.create_task(reminder_delivery_loop(state.redis)) if state.redis else None

    yield

    # Shutdown
    logger.info("Shutting down sub-agent...")
    state.running = False

    if state.poll_task is not None:
        state.poll_task.cancel()
        try:
            await state.poll_task
        except asyncio.CancelledError:
            pass
    if getattr(state, 'reminder_task', None) is not None:
        state.reminder_task.cancel()
        try:
            await state.reminder_task
        except asyncio.CancelledError:
            pass

    if state.redis is not None:
        await state.redis.close()
        logger.info("Redis connection closed")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Clawd Sub-Agent",
    description="Per-user AI agent for message processing, RAG, and document ingestion",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """Health check endpoint for container monitoring."""
    redis_ok = False
    if state.redis is not None:
        try:
            await state.redis.ping()
            redis_ok = True
        except Exception:
            redis_ok = False

    uptime = (datetime.now(timezone.utc) - state.started_at).total_seconds()

    return HealthResponse(
        status="healthy" if redis_ok else "degraded",
        user_id=state.settings.agent.user_id,
        redis_connected=redis_ok,
        uptime_seconds=uptime,
        version=state.settings.version,
    )


@app.post("/process", response_model=ProcessResponse)
async def process_direct(request: ProcessRequest) -> ProcessResponse:
    """
    Direct message processing endpoint.

    Primarily used for testing and admin access. In production, messages
    arrive via the Redis queue polling loop.
    """
    if not state.settings.agent.user_id:
        raise HTTPException(status_code=503, detail="Agent user_id not configured")

    message = InboundMessage(
        message_id=f"direct-{datetime.now(timezone.utc).timestamp():.0f}",
        user_id=state.settings.agent.user_id,
        content=request.content,
        timestamp=datetime.now(timezone.utc).isoformat(),
        metadata=request.metadata,
    )

    response = await process_message(message)

    return ProcessResponse(
        content=response.content,
        metadata=response.metadata,
    )
