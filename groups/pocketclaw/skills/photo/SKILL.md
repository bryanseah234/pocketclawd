---
name: photo
description: Manually store a photo description in mnemon (used when auto-pipeline failed).
---

# /photo — manually save a photo description

Usage:

```
/photo <description>
```

Action:

1. Take everything after `/photo ` as the description text.
2. Call `mnemon remember --photo "<description>" --source manual`.
3. Reply: `Photo description stored: <first 60 chars>…`.

Use cases:

- The vision model timed out during auto-processing.
- A previously-deleted photo needs to be re-described (e.g., printed photo of a whiteboard).
- Backfilling memories from older conversations.

The auto-pipeline (Telegram/WhatsApp photo attachment → `processPhoto()`) is preferred — only use `/photo` for manual entry.
