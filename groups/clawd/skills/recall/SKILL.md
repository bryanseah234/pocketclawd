---
name: recall
description: Search Clawd's memory for facts related to a query.
---

# /recall — search the knowledge base

Usage:

```
/recall <query>
```

Action:

1. Take everything after `/recall ` as the search query.
2. Call the MCP tool `kb_recall` with:
   - `query`: the user's query, verbatim
   - `k`: 5 (the default — bump to 10 if the query is broad, e.g. "what do you know about Caroline")
3. The tool returns `{ insights: [{ id, text, source, source_id?, tags?, entities?, category?, importance? }, ...] }`.
4. Format the reply as one fact per bullet, quoting the `text` field. Cite the `source` if it's `gmail` / `outlook` / `photo` (the user knows that means it came from ingestion, not from his own messages).
5. If `insights` is empty: reply `No memories found for "<query>". Try broader keywords or use /memory to teach me first.`

Tips:

- Recall is semantic (pgvector embeddings), not keyword search. Phrase the query the way the user asked, not the way the fact might have been stored.
- If you suspect the embedding model is offline (recall returns nothing for a query that should obviously hit), call `kb_status` once to confirm before claiming "I don't remember".
