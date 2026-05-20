---
name: status
description: Show PocketClaw status — mnemon entity count, last ingestion run, watcher health.
---

# /status

Usage:

```
/status
```

Action — gather and reply with:

1. **Memory**: `mnemon list --type entity --format count` → entity count
2. **Last ingestion**: most recent `IngestSummary` (read from `${LOG_PATH}/last-ingest.json` if cached, else "never run")
3. **File watcher**: count of files in `${WATCH_PATHS_ROOT}` and whether the watcher process is alive
4. **Cron schedule**: next run times for the 02:00 / 03:00 / 07:00 jobs
5. **Cloud sources**: which of Google / Microsoft / Apple have valid tokens

Format as a compact bulleted list. No more than 8 lines.
