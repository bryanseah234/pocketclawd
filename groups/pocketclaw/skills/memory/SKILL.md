---
name: memory
description: Manually save a fact to PocketClaw's persistent memory.
---

# /memory — store a fact in mnemon

Usage:

```
/memory <fact>
```

Action:

1. Take everything after the `/memory ` prefix as the fact text.
2. Call `mnemon remember "<fact>"` from the agent shell.
3. Reply: `Remembered: <fact>` so the user has confirmation.

If `mnemon` is not on PATH, reply with: `Memory engine not installed. Run /add-mnemon at the host first.`

Examples:

- `/memory Sarah Chen prefers email over phone calls.` → mnemon remember stores the fact.
- `/memory My DBS account number is …` → store securely; never echo back in plain text on subsequent recalls.
