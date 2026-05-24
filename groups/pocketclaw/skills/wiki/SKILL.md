---
name: wiki
description: Generate or regenerate an Obsidian wiki entry for an entity (NOT YET WIRED).
---

# /wiki — regenerate wiki entry

## Status

**Not yet wired.** The wiki generator (`src/modules/wiki-generator.ts`) reads from the knowledge base and writes Markdown to `${VAULT_PATH}/wiki/`. It runs on the host as a 03:00 local cron.

Today the cron is a no-op stub: the audit log shows `wiki-regen | SKIP | no-provider`. Re-wiring it requires a host-side handler that calls `WikiGenerator.generateEntry(...)` directly (no provider needed — wiki generation is purely a transform of pgvector data into Markdown). That's a separate plan.

You — the in-container agent — cannot drive wiki regeneration. There is no MCP tool for it; it would need `kb_recall` over the entity, then a Markdown write to a host-mounted vault path, which is host-side work.

## What to do when the user types `/wiki <topic>`

1. Acknowledge the wiki-regen cron is currently parked.
2. Offer to summarise what you know about the topic by calling `kb_recall(query=<topic>, k=10)` and replying with a chat-formatted summary.
3. Note that the formal wiki entry at `vault/wiki/<topic>.md` won't be regenerated until the cron handler is restored.

## Forward link

Tracked in: `.omo/plans/pocketclaw-knowledge-rearch.md` (P5 audit log) and the follow-on `.omo/plans/wiki-cron-rewire.md` (to be written).
