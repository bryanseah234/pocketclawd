# API Reference

The orchestrator exposes a minimal HTTP API on port 3000.
All endpoints require basic auth (admin / ADMIN_PASS from Secrets Manager).

Base URL: http://3.0.132.150:3000 (no TLS until C9)

## Admin dashboard

GET /admin
  HTML admin dashboard. View queue state, user histories, send test messages.

## Health

GET /health
  Returns 200 {"status":"ok"} if the orchestrator is up.
  Used by the load balancer and monitoring.

## Send a test message (admin)

POST /admin/send
  Content-Type: application/json
  Body: {"userId": "test_alpha", "content": "Hello", "channelType": "admin-test"}

  Injects a message as if it came from a real user. Response appears in the
  admin dashboard and in the outbound queue.

## Data gateway (internal)

The data gateway is an internal worker (not a public HTTP API).
The sub-agent pushes requests to queue:orchestrator:data_gateway via Redis
and waits on queue:agent:{userId}:dg_response:{requestId}.

Operations: probe_user_preferences, set_user_preferences, get_chat_history,
store_message, delete_user_data, get_document_list, delete_document,
ingest_url, get_url_status.

## Redis queue protocol

All inter-process communication uses Redis lists (LPUSH / BRPOP).

Inbound message envelope (orchestrator -> sub-agent):
```json
{
  "id": "msg-uuid",
  "userId": "154320684",
  "type": "chat",
  "payload": {
    "content": "{"text":"Hello","sender":"65857...@s.whatsapp.net","attachments":[]}",
    "channelType": "whatsapp",
    "platformId": "65857...@s.whatsapp.net",
    "threadId": null
  },
  "timestamp": "2026-06-02T04:36:00.000Z"
}
```

Outbound response envelope (sub-agent -> orchestrator):
```json
{
  "id": "resp-uuid",
  "userId": "154320684",
  "type": "chat",
  "payload": {
    "content": "Here are today's headlines...",
    "channelType": "whatsapp",
    "platformId": "65857...@s.whatsapp.net",
    "threadId": null
  },
  "timestamp": "2026-06-02T04:36:05.000Z"
}
```

Content field for media responses:
- Image:    IMAGE_URL:https://nanoclaw-data-*.s3.amazonaws.com/media/generated/UUID.png:IMAGE_URL
- Document: DOC_URL:https://nanoclaw-data-*.s3.amazonaws.com/media/generated/UUID.pdf:DOC_URL
- Audio:    AUDIO_URL:https://nanoclaw-data-*.s3.amazonaws.com/media/generated/UUID.mp3:AUDIO_URL

## Sub-agent FastAPI endpoints (internal)

The sub-agent runs FastAPI on port 8000 inside the ECS task (not public).

GET  /health        Container health check
POST /process       Process a single message (used in local dev / testing)
GET  /metrics       Prometheus metrics (latency, queue depth, error rate)

## Slash commands (user-facing)

Handled in container/sub-agent/src/commands.py before the LLM pipeline.

/help                  Command list
/list                  List your saved documents
/delete <id>           Delete a document
/profile               Show your profile
/profile set <k> <v>   Update a profile field
/remind me to X at Y   Set a reminder
/reminders             List pending reminders
/remindclear <id>      Cancel a reminder
/forget                Delete all your data
/forget-url <url>      Remove a specific URL from your knowledge base
/privacy               Data handling explanation
/digest on|off         Enable or disable the morning digest
