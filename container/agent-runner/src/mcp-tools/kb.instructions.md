## Knowledge base (`kb_remember`, `kb_recall`, `kb_list_top_entities`, `kb_status`, `kb_forget`)

You have a long-term knowledge base — a Postgres + pgvector store of insights about Bryan, his projects, and his world. Use it as your durable memory across sessions. The file `CLAUDE.local.md` in your workspace is short-form pinned context; the KB is everything else.

These tools are restricted to the **clawd agent group** — they will refuse from any other agent group with `kb_* tools are restricted to the clawd agent group.` Do not advertise them outside this group.

### When to remember (`kb_remember`)

Save an insight whenever the user shares something durable that you'll want to surface again later — preferences, decisions, recurring people/places/projects, dates, choices, opinions. Prefer one focused fact per call (the embedding is per-row), not a paragraph dump.

```
kb_remember(text="Bryan's wife Caroline is allergic to peanuts.",
            source="chat",
            entities=["Caroline"],
            tags=["health", "family"])
```

`source` is the origin tag — `chat` for things he tells you in conversation, `agent-memory` for your own observations, `photo` / `gmail` / `outlook` are reserved for the host-side ingestion pipelines (don't reuse those). `source_id` is optional — pass a stable id (e.g. an email message-id) to dedup re-ingestion. `tags` and `entities` are free-form and help recall.

Do **not** write trivia, single-turn task state, or things he obviously already knows. The KB is for facts that stay true beyond the current chat.

### When to recall (`kb_recall`)

Before answering anything that references past context — "as I told you", "remember when", "what was that thing about X" — call `kb_recall` first. It does semantic search, so phrase the query the way the user would, not the way the insight was originally stored.

```
kb_recall(query="what's Caroline allergic to", k=5)
```

Returns `{ insights: [{ id, text, source, source_id?, tags?, entities?, category?, importance? }, ...] }`. Quote them naturally in your reply (don't paste the raw row); cite the source if relevant ("from your message yesterday…", "from the photo you sent…").

If recall returns nothing for a query that should obviously have a hit, the KB may be empty or the embedding model offline — use `kb_status` to confirm before telling the user "I don't remember".

### Status and entity overview

`kb_status()` returns `{ total, topEntities }` — the total insight count and the top-10 most-mentioned entities. Use it as a health check or when the user asks "what do you know about me?".

`kb_list_top_entities(limit=20)` is the longer form — returns `{ entities: [{ entity, count }, ...] }` ranked by mention count.

### Forgetting

`kb_forget(id)` deletes an insight by its numeric id (from `kb_recall`). **Irreversible.** Only call when the user explicitly asks you to forget something, or when an insight is verifiably wrong. Never forget proactively to "tidy up" — Bryan owns the retention policy.

### Failure modes

- **15s timeout**: the host handler is slow or Postgres is down. Apologise once, suggest he retry; do not invent a fallback.
- **`Error: PG down`** or similar from the host: same — surface the error verbatim, don't paper over it.
- **Permission refusal**: only happens outside the clawd group, which is a configuration bug — report it back as-is.

### Things this is NOT

- Not a place to log every chat turn — there's a separate `chat-archive` host pipeline for that, you don't need to touch it.
- Not a place for big binary blobs (photos, audio). Those go through host-side processors that emit a text description into the KB on your behalf.
- Not a wiki. Wiki regeneration is a host-side cron that reads from the KB; you can't drive it from here yet.
