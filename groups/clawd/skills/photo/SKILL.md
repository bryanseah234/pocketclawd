---
name: photo
description: Manually store a photo description in the knowledge base (used when auto-pipeline failed).
---

# /photo — manually save a photo description

Usage:

```
/photo <description>
```

Action:

1. Take everything after `/photo ` as the description text.
2. Call the MCP tool `kb_remember` with:
   - `text`: the description, verbatim
   - `source`: `"manual-photo"` (distinguishes manual entry from the host-side `photo` source used by the auto-pipeline)
3. Reply: `Photo description stored: <first 60 chars>…`.

Use cases:

- The vision model timed out during auto-processing.
- A previously-deleted photo needs to be re-described (e.g., printed photo of a whiteboard).
- Backfilling memories from older conversations.

The auto-pipeline (Telegram/WhatsApp photo attachment → host-side `processPhoto()` → `kb_remember(source="photo")`) is preferred — only use `/photo` for manual entry. The two `source` tags (`photo` vs `manual-photo`) make it easy to audit which path produced an insight.
