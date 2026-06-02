# Sub-agent internals

The sub-agent is a Python FastAPI service running in ECS Fargate.
Entry point: container/sub-agent/src/main.py.

## Message processing flow

1. BRPOP from queue:agent:dispatch (30s timeout, then re-poll)
2. Parse payload JSON. Extract text + attachments from content field.
3. If attachments contain images: fetch bytes from S3 staging key,
   store on message metadata for vision input.
4. Consent gate (PDPA): if user has not given consent, send consent request
   and stop processing.
5. Onboarding check: if user is new, run discovery_skill (3-question flow).
6. Rate limiter: check Redis rate limit key. If exceeded, send backpressure reply.
7. Slash command routing: if content starts with /, dispatch to handle_command().
8. Parallel fetch: chat history (DynamoDB / Redis cache) + embed user message.
9. OpenSearch hybrid search (vector + BM25, top-5 chunks).
10. Assemble system prompt from persona JSON + user profile.
11. Bedrock Converse call with tool loop (max 6 turns):
    - Model can call any registered tool
    - Tool result is appended to conversation
    - Loop ends when model returns a text response (stopReason=end_turn)
12. Fake image marker interception (see architecture.md).
13. Store assistant response to DynamoDB (fire-and-forget asyncio task).
14. Synchronous Redis cache bust (delete cache:chat_history:{userId}).
15. LPUSH response envelope to queue:orchestrator:responses.

## Tool registry

Tools are registered in container/sub-agent/src/tools/__init__.py.
TOOL_DEFINITIONS: list of Bedrock tool spec dicts.
_DISPATCH: dict mapping tool name -> async callable.

Current tools:
- web_search: Google News RSS + web search, resolves source URLs
- get_news: RSS feeds (CNA, BBC, Guardian, Mothership, NYT, ST)
- get_weather: OpenWeatherMap (keyless endpoint)
- find_place: Nominatim geocoding with proximity phrase normalisation
- get_directions: OSRM routing with human-speed override for cycling/walking
- get_stock_price: Yahoo Finance (keyless)
- get_crypto_price: CoinGecko (keyless)
- fetch_url: httpx + trafilatura for article content extraction
- generate_image: Bedrock Titan Image Generator v2, uploads to S3
- generate_document: reportlab (PDF) or python-docx (DOCX), uploads to S3
- create_reminder, list_reminders, cancel_reminder: Redis sorted-set reminders
- search_knowledge_base: AOSS hybrid search directly
- store_note: Embed + index a user note

## LLM client

container/sub-agent/src/llm/client.py.

- Model: Claude Sonnet 4.5 via Bedrock Converse
- Max tokens: 4096
- Tool loop: up to 6 turns (tool_use -> tool_result -> next turn)
- Vision: if message.metadata._image_bytes_list is set, image content blocks
  are prepended to the user message before the text block
- History: last N turns from Redis cache (cache:chat_history:{userId})
- Empty content block guard: strips messages with blank content before sending
  to avoid Bedrock ValidationException

## RAG pipeline

container/sub-agent/src/rag/pipeline.py.

- Embed user message: Titan Embed v2 via Bedrock
- AOSS hybrid query: knn (vector) + match (BM25) with equal weighting
- Top 5 chunks returned, deduped, injected into system prompt
- RAG context only injected if chunks score above a threshold
- Cache: per-user embed cache (cache:embed:{userId}:{hash}) with 5min TTL

## Reminders

container/sub-agent/src/reminders.py.

- Stored in Redis sorted set: reminders:{userId}
- Score: fire-at Unix timestamp
- Member JSON: {id, text, createdAt, channelType, platformId}
- Delivery loop: scans every 30s, fires due reminders, removes from set
- channelType and platformId are stored at creation so reminders fire to
  the correct platform (WhatsApp @s.whatsapp.net vs Telegram numeric chat_id)

## Inbound image handling

When the WhatsApp or Telegram adapter receives an image:
1. Adapter downloads to local disk
2. Uploads to S3: users/{userId}/staging/{channel}-{msgId}/{filename}
3. Router serialises {text, sender, attachments:[{type:image,s3Key,...}]}
   as JSON into the Redis queue payload content field
4. Sub-agent main.py parses the JSON, extracts s3Key from attachments
5. Fetches raw bytes from S3 (GetObject)
6. Passes bytes to client.py generate() as image_bytes_list
7. Bedrock Converse receives image content blocks before the text block

## Error handling

- Tool errors: caught, formatted as "Tool error: <msg>", loop continues
- LLM timeout (45s): returns canned "taking a bit longer" message
- DLQ: messages that fail 3 times are pushed to queue:agent:{userId}:dlq
- Asyncio task GC: fire-and-forget tasks are held in _bg_tasks set to
  prevent garbage collection before completion

## Configuration

All config via environment variables, read by pydantic-settings in
container/sub-agent/src/config.py. See docs/deployment.md for the full list.
