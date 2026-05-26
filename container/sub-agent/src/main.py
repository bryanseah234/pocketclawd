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
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .config import Settings, get_settings

logger = logging.getLogger(__name__)

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
        socket_timeout=10,
    )
    await client.ping()
    return client


async def enqueue_response(response: AgentResponse) -> None:
    """Push a response onto the orchestrator's response queue."""
    if state.redis is None:
        raise RuntimeError("Redis not connected")
    payload = response.model_dump_json()
    await state.redis.lpush(state.settings.response_queue_key, payload)
    logger.info(
        "Enqueued response for message_id=%s user_id=%s",
        response.message_id,
        response.user_id,
    )


# ---------------------------------------------------------------------------
# Message processing
# ---------------------------------------------------------------------------


async def process_message(message: InboundMessage) -> AgentResponse:
    """
    Process a single inbound message and produce a response.

    This is the core processing function. In later tasks it will be extended
    to handle:
      - RAG-based knowledge queries (task 7.4)
      - Document ingestion commands (task 7.7)
      - Slide generation (task 7.10)
      - LLM communication via Bedrock (task 7.2)

    For now, it acknowledges receipt and echoes back a placeholder response.
    """
    logger.info(
        "Processing message_id=%s from user_id=%s",
        message.message_id,
        message.user_id,
    )

    # Placeholder: will be replaced with actual LLM + RAG pipeline
    response_content = (
        f"Received your message. Processing is not yet implemented. "
        f"(message_id={message.message_id})"
    )

    return AgentResponse(
        message_id=message.message_id,
        user_id=message.user_id,
        content=response_content,
        timestamp=datetime.now(timezone.utc).isoformat(),
        metadata={"source": "sub-agent", "processed": True},
    )


# ---------------------------------------------------------------------------
# Queue polling loop
# ---------------------------------------------------------------------------


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

            # BRPOP blocks until a message arrives or timeout elapses
            result = await state.redis.brpop(queue_key, timeout=timeout)

            if result is None:
                # Timeout — no message available, loop again
                continue

            _key, raw_payload = result
            logger.debug("Received raw payload from queue: %s", raw_payload[:200])

            try:
                data = json.loads(raw_payload)
                message = InboundMessage(**data)
            except (json.JSONDecodeError, ValueError) as e:
                logger.error("Failed to parse inbound message: %s", e)
                continue

            # Process and respond
            response = await process_message(message)
            await enqueue_response(response)

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

    if state.redis is not None:
        await state.redis.close()
        logger.info("Redis connection closed")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="NanoClaw Sub-Agent",
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
