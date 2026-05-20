---
name: digest
description: Manually trigger the morning digest delivered to Telegram.
---

# /digest — generate and send morning digest

Usage:

```
/digest
```

Action:

1. Recall yesterday's email facts from mnemon: `mnemon recall --query "email" --since 1d`
2. Recall today's calendar events: `mnemon recall --query "calendar" --range today`
3. Recall pending commitments: `mnemon recall --query "promised|will send|owe" --depth 2`
4. Compose a morning summary in the format from PRD §8.2:
   - 📧 Yesterday's emails (top 3, sender + subject + 1-line summary)
   - 📅 Today's calendar (time + title + duration)
   - 📋 Pending commitments (item + due-by)
5. Send via Telegram (or current channel if not Telegram).

Auto-runs daily at 07:00 local. Manual invocation is for testing or skipping ahead.
