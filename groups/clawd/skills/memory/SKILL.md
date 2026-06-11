---
name: memory
description: Manually save a fact to Clawd's persistent memory.
---

# /memory — store a fact in the knowledge base

Usage:

```
/memory <fact>
```

Action:

1. Take everything after the `/memory ` prefix as the fact text.
2. Call the MCP tool `kb_remember` with:
   - `text`: the fact, verbatim
   - `source`: `"chat"` (it came from a direct user instruction)
3. Reply: `Remembered: <fact>` so the user has confirmation.

If `kb_remember` returns an error, surface it verbatim — do not fabricate a fallback. The most common cause is the host-side Postgres being down; the user will know to check.

Examples:

- `/memory Sarah Chen prefers email over phone calls.` → `kb_remember(text="Sarah Chen prefers email over phone calls.", source="chat", entities=["Sarah Chen"])`
- `/memory My DBS account number is …` → store, but never echo the value back on subsequent recalls.

When you can extract structure cheaply, do — pass `entities=[...]` for named people/places/orgs, `tags=[...]` for topical keywords. They make `/recall` better. Don't over-engineer it.
