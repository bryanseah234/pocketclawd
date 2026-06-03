# API & Interfaces Reference

## Admin HTTP API (orchestrator, port 3000)

Basic auth (`admin` / `ADMIN_PASS`). Base URL `http://3.0.132.150:3000` (no TLS until C9).

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin` | HTML dashboard — queue state, histories, test messages |
| GET | `/health` | `200 {"status":"ok"}` if orchestrator is up |
| POST | `/admin/send` | inject a test message `{userId, content, channelType}` |

## Sub-agent FastAPI (internal, port 8000, not public)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | container health |
| POST | `/process` | process one message (local dev / testing) |
| GET | `/metrics` | Prometheus metrics |

## Redis message envelopes

Inbound (orchestrator → sub-agent):
```json
{ "id": "msg-uuid", "userId": "154320684", "type": "chat",
  "payload": { "content": "{\"text\":\"Hello\",\"sender\":\"65857...@s.whatsapp.net\",\"attachments\":[]}",
               "channelType": "whatsapp", "platformId": "65857...@s.whatsapp.net", "threadId": null },
  "timestamp": "2026-06-02T04:36:00.000Z" }
```

Outbound (sub-agent → orchestrator): same shape with `content` as the reply
text, or a media marker:

- Image: `IMAGE_URL:https://nanoclaw-data-*.s3.amazonaws.com/media/generated/UUID.png:IMAGE_URL`
- Document: `DOC_URL:...UUID.pdf:DOC_URL`
- Audio: `AUDIO_URL:...UUID.mp3:AUDIO_URL`

## Data gateway (internal worker, not HTTP)

The sub-agent LPUSHes to `queue:orchestrator:data_gateway` and waits on
`queue:agent:{userId}:dg_response:{requestId}`. Operations:
`probe_user_preferences`, `set_user_preferences`, `get_chat_history`,
`store_message`, `delete_user_data`, `get_document_list`, `delete_document`,
`ingest_url`, `get_url_status`.

## Slash commands (user-facing)

Handled in `container/sub-agent/src/commands.py` before the LLM pipeline.

| Command | Action |
|---|---|
| `/help` | command list |
| `/list` | list saved documents |
| `/delete <id>` | delete a document |
| `/profile` / `/profile set <k> <v>` | show / update profile |
| `/remind me to X at Y` | set a reminder |
| `/reminders` / `/remindclear <id>` | list / cancel reminders |
| `/forget` / `/forget-url <url>` | delete all data / one URL |
| `/privacy` | data-handling explanation |
| `/digest on\|off` | toggle the morning digest |
