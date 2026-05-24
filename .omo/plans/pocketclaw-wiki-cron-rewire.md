# PocketClaw Wiki Cron Re-wire

**Status:** STUB — awaiting prioritization
**Replaces:** the no-op stub at the 03:00 local cron (`audit log: wiki-regen | SKIP | no-provider`)
**Forward-linked from:** `groups/pocketclaw/skills/wiki/SKILL.md`

## Why parked

The 03:00 wiki regeneration cron currently logs `SKIP | no-provider`. The handler was originally tied to a Bedrock invocation that fed entity-context into a model and asked it to compose Markdown wiki pages. Bedrock removal in Phase 5 of the knowledge re-arch left no provider behind it. The job ticks but does nothing.

`src/modules/wiki-generator.ts` itself **still works**: `WikiGenerator.generateEntry({ entityName })` reads the knowledge base via `kb.recall(entity, { k: 30 })` plus `kb.topEntities()` and writes Markdown to `${VAULT_PATH}/wiki/<sanitized>.md`. The module is pure-transform — no LLM call needed for the v0 shape. What's missing is the cron-side glue that decides *which* entities to regenerate each night.

## Proposed wire-up

Two options, pick at plan-promotion time:

### A. Pure transform (cheapest)

Cron handler (host-side, no container, no LLM):

1. `kb.topEntities(50)` → list of (entity, count) pairs above some threshold (count >= 3?).
2. For each entity, `WikiGenerator.generateEntry({ entityName })` writes the Markdown page (overwrites).
3. Audit-log per regen: `wiki-regen | OK | <entity> | <bytes>`.

This is 30 lines of TypeScript and reuses existing modules. No provider. No agent. Safe to ship.

### B. Agent-driven (richer prose)

Same selection step, but instead of pure transform, write a `system` action onto the pocketclaw container's `inbound.db` asking the agent to call `kb_recall(entity, k=30)` + synthesize a wiki entry, then return the Markdown via a new `wiki_write` system action that the host renders to disk.

More expressive (the agent can write narrative prose rather than bulleted facts), but adds round-trip latency, container-must-be-running coupling, and a new `wiki_request` / `wiki_response` action pair on the existing M0 transport.

Recommend: ship A first; promote to B if A's output is too mechanical to be useful.

## Dependencies

- Knowledge base (already done, P1-P7).
- For option B: extend the M0 system-action handler in `src/modules/knowledge-base/kb-actions.ts` (or factor into a sibling `wiki-actions.ts`) to handle `wiki_write` from the container.

## Files that change

- New: `src/modules/wiki-cron-handler.ts` — implements option A.
- Edit: wherever the 03:00 cron is registered (search for `wiki-regen` audit-log emit) — wire `wiki-cron-handler` as the handler.
- Edit: `groups/pocketclaw/skills/wiki/SKILL.md` — once wired, remove the NOT YET WIRED banner.

## Acceptance

- Run cron manually via host tooling. Audit log: `wiki-regen | OK | <N> entities | <ms>ms`.
- `${VAULT_PATH}/wiki/` has one .md per entity.
- vitest: at least one happy-path test for `wiki-cron-handler` against an in-memory `KnowledgeBase` mock.

## Out of scope

- Cleanup of stale wiki pages (entities that fall off the topN list). Defer.
- Inter-page WikiLinks (`[[Other Entity]]`). Already supported by `wiki-generator.ts`; no extra work.
- A tuning UI for "which entities deserve a page". The threshold lives in code; tweak via PR.
