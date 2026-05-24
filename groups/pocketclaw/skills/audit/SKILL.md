---
name: audit
description: Show PocketClaw's audit log entries for a date.
---

# /audit — review tool-call audit log

Usage:

```
/audit             # default: today
/audit yesterday   # last 24h
/audit 2026-05-20  # specific date
```

Action:

1. Read `/tmp/audit.log` (mounted from host `${LOG_PATH}/audit.log`).
2. Filter to the requested date.
3. Group entries by category: RECV, BATCH, TOOL, PHOTO, WRITE, SEND, IGNORE, KB.
4. Show counts per category, then list the 10 most recent entries verbatim.

Fields per entry: `<ISO timestamp> | <category> | <platform/tool> | <details>`.

The `KB` category is new — it logs every `kb_request` / `kb_response` round-trip from the in-container `kb_*` MCP tools (tool name, request_id, latency_ms, error if any). If the user is debugging "why doesn't /memory work?" or "is recall slow?", that's where to look.

Privacy reminder: audit log lives ON-DEVICE. Never upload it. Never paste it into a public channel.
