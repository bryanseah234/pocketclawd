# Architecture

Clawd is a two-process system: an orchestrator (Node.js on EC2) and a
sub-agent pool (Python on ECS Fargate). They communicate exclusively through
Redis queues. There is no direct IPC or shared memory.

## Components

```
User (WhatsApp / Telegram)
        |
        v
  Channel Adapter          src/channels/whatsapp.ts
  (Orchestrator, EC2)      src/channels/telegram.ts
        |
        v
   Router                  src/router.ts
   - resolves user -> session
   - writes to Redis queue
        |
   Redis queue:agent:dispatch
        |
        v
   Sub-Agent (ECS Fargate) container/sub-agent/src/main.py
   - BRPOP inbound queue
   - RAG pipeline (embed -> AOSS search -> Bedrock LLM)
   - Tool loop (web search, maps, image gen, doc gen, etc.)
   - LPUSH response to queue:orchestrator:responses
        |
   Redis queue:orchestrator:responses
        |
        v
   Delivery poller          src/delivery.ts
   - reads response
   - dispatches kind=chat/image/audio/document to correct adapter
        |
        v
  Channel Adapter (send)
```

## Queue keys

| Key | Direction | Description |
|---|---|---|
| queue:agent:dispatch | orchestrator -> sub-agent | shared worker pool inbound |
| queue:agent:{userId}:inbound | orchestrator -> sub-agent | per-user on-prem path |
| queue:orchestrator:responses | sub-agent -> orchestrator | all outbound responses |
| queue:agent:{userId}:dg_response:{reqId} | data gateway -> sub-agent | DG response |
| queue:agent:{userId}:dlq | system | dead-letter queue (3 retries) |
| nanoclaw:uploads:pending | whatsapp adapter -> processor | inbound media staging |

## Data stores

| Store | Purpose |
|---|---|
| DynamoDB nanoclaw-chat-messages | Per-user conversation history |
| DynamoDB nanoclaw-user-preferences | Onboarding state, profile, digest settings |
| DynamoDB nanoclaw-system-errors | Error log |
| DynamoDB nanoclaw-webhook-tokens | Scheduled message tokens |
| OpenSearch Serverless nanoclaw-documents | Per-user document chunks (vector + BM25) |
| S3 nanoclaw-data-709609992277 | Uploaded docs, generated images, generated PDFs |
| Redis nanoclaw-redis | Message queues, rate limits, reminder sorted sets, cache |

## Inbound media flow (WhatsApp / Telegram)

1. Adapter downloads media to local disk (ECS task ephemeral storage)
2. Uploads to S3 staging: users/{userId}/staging/wa-{msgId}/{filename}
3. For images: fetched from S3 and passed as Bedrock vision content blocks
4. For documents: pushed to nanoclaw:uploads:pending Redis list for async indexing

## Response kinds

The sub-agent writes a plain string to the response queue. The orchestrator
delivery.ts reads the string, detects the kind, and dispatches:

- Plain text -> kind=chat -> sendMessage text
- IMAGE_URL:<s3-presigned-url>:IMAGE_URL -> kind=image -> sendPhoto / sendMessage image
- DOC_URL:<s3-presigned-url>:DOC_URL -> kind=document -> sendDocument
- AUDIO_URL:<s3-presigned-url>:AUDIO_URL -> kind=audio -> sendAudio

## Sub-agent processing pipeline

For each inbound chat message:

1. Parse content JSON from queue payload (extract text + attachments)
2. Fetch image bytes from S3 if attachments present
3. Consent check (PDPA gate)
4. Onboarding / discovery skill (new users)
5. Rate limiter check
6. Slash command routing (/help, /list, /remind, /profile, etc.)
7. Parallel: chat history fetch + RAG embed
8. OpenSearch hybrid search (vector + BM25)
9. Bedrock Converse with tool loop (up to 6 turns)
10. Fake image marker interception (auto-retry generate_image)
11. Store response to DynamoDB (fire-and-forget)
12. Bust Redis chat-history cache synchronously
13. LPUSH response to orchestrator queue

## Morning digest

Runs at 07:00 SGT via cron in src/modules/clawd-wiring.ts.
Scans DynamoDB nanoclaw-user-preferences for users where
consentGiven=true and dailyDigestEnabled=true.
Generates a 3-bullet 24-hour digest per user via Bedrock Sonnet 4.5.
Delivers via the user's registered channel adapter.
No-ops when zero users are opted in.

## Reminder delivery

Reminders are stored in Redis sorted sets (key: reminders:{userId}).
Score is fire-at Unix timestamp. channelType and platformId are stored
in the JSON member so reminders fire to the correct platform at delivery time.
The reminder_delivery_loop in the sub-agent scans every 30 seconds.

## Fake image handling (defence-in-depth)

Claude sometimes emits fake markers (IMAGE_GENERATING:..., pollinations.ai URLs)
instead of calling the generate_image tool. Two interception layers:

1. main.py: regex scan on every response before enqueue. Detects
   IMAGE_GENERATING:...:IMAGE_GENERATING, IMAGE_URL:<non-s3>:IMAGE_URL,
   [Image: ...], etc. Extracts the description, calls generate_image for real.

2. index.ts: delivery side. Only dispatches kind=image for IMAGE_URL markers
   whose URL is under nanoclaw-data-*.s3.amazonaws.com/media/generated/.
   Anything else is delivered as plain text.
