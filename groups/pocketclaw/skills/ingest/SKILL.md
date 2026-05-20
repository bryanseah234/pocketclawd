---
name: ingest
description: Trigger an immediate cloud ingestion run (Gmail / Outlook / iCloud).
---

# /ingest — manual cloud ingestion

Usage:

```
/ingest
```

Action:

1. Invoke `CloudScheduler.runAll()` from `src/modules/ingestion/scheduler.ts`.
2. Each ingester (Google × 3, Microsoft × 3, Apple × 3) runs in parallel with fault isolation.
3. Reply with a per-source summary: `<source>: <factsCount> facts, <errorCount> errors`.
4. If any source has >0 errors, list the first one for diagnostic context.

Notes:

- Default: pulls last 24 h. Pass `--since 2026-05-01` to override.
- Auto-runs daily at 02:00 local — you usually don't need to invoke this manually.
