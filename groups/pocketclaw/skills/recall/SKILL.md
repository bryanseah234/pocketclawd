---
name: recall
description: Search PocketClaw's memory graph for facts related to a query.
---

# /recall — search mnemon

Usage:

```
/recall <query>
```

Action:

1. Take everything after `/recall ` as the search query.
2. Call `mnemon recall --query "<query>" --depth 3 --format plain`.
3. Format the top results into a clean response (one fact per bullet).
4. If no results: reply `No memories found for "<query>". Try broader keywords or use /memory to teach me first.`

Tips:

- Use specific entity names ("Sarah Chen") or topical keywords ("DBS Q3 budget").
- Recall is graph-based — a query for one entity surfaces linked facts.
