---
name: ingest
description: Status of the cloud-ingestion pipeline (Gmail / Outlook). Runs automatically at 02:00 SGT.
---

# /ingest — cloud ingestion status

```
/ingest
```

## What ingestion does

At 02:00 SGT every day the orchestrator fetches new content from every user's
connected accounts and indexes it into the knowledge base:

- **Google** — Gmail unread + Calendar events (for users who ran `/connect google`)
- **Microsoft** — Outlook unread + Calendar events (for users who ran `/connect microsoft`)

Results are stored in OpenSearch under each user's isolated partition and become
available to `kb_recall` immediately.

## What to do when the user types `/ingest`

1. Tell them ingestion runs automatically at 02:00 SGT. Manual triggers are
   not exposed via chat.
2. Offer to check recent activity: "I can look up what was indexed last — want me to
   search your knowledge base for something specific?"
3. If they want to check connection status: suggest `/connect status`.

## What is NOT supported

- **Apple / iCloud** — no iCloud API support, not planned.
- In-chat manual trigger — ingestion is host-side only, no MCP tool for it.
