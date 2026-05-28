---
name: ingest
description: Status of the cloud-ingestion pipeline (Gmail / Outlook / iCloud).
---

# /ingest — cloud ingestion status

Usage:

```
/ingest
```

## Status

**Host-only.** Cloud ingestion runs on the host as a 02:00 local cron (see `src/modules/ingestion/scheduler.ts`). Each ingester (Google × 3, Microsoft × 3, Apple × 3) runs in parallel with fault isolation, writes results into the host-side knowledge base, and records per-source counts in the audit log.

You — the in-container agent — **cannot trigger ingestion directly**. There is no MCP tool for it (yet); the scheduler's `runAll()` is host-side TypeScript with no transport into the container.

## What to do when the user types `/ingest`

1. Acknowledge: ingestion runs automatically at 02:00 local each day; manual triggers happen on the host.
2. Offer to check the audit log via `/status` — that surfaces the most recent ingestion's per-source counts and timestamp.
3. If the user actually wants to fire an ingestion off-schedule, tell them the host-side incantation (it's not a chat-driven action):

```
# On the host:
pnpm exec tsx scripts/run-ingestion.ts
```

(Or wait for the 02:00 cron.)

## Why no MCP tool

The kb_* MCP tools cover read/write of the knowledge base itself. Ingestion is a pipeline of cloud-API adapters that need OAuth tokens, network access, and host-side filesystem cache — none of which the container should have. A future plan may expose `kb_run_ingestion(source?)` if the friction warrants it; today the cron + audit-log inspection is the supported path.
