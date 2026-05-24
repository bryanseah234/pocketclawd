# PocketClaw Morning Digest Re-wire

**Status:** STUB — awaiting prioritization
**Replaces:** the no-op stub at the 07:00 local cron (`audit log: morning-digest | SKIP | no-handler`)
**Forward-linked from:** `groups/pocketclaw/skills/digest/SKILL.md`

## Why parked

The 07:00 morning digest cron currently logs `SKIP | no-handler`. PRD §8.2 specifies the format: emoji-prefixed bullet sections for *Yesterday's emails* (📧, top 3), *Today's calendar* (📅), and *Pending commitments* (📋). The original handler was tied to Bedrock; the knowledge-base re-arch ripped Bedrock out and didn't replace the digest path.

The cron ticks but produces no message.

## Proposed wire-up

Cron handler (host-side):

1. **Gather context via `KnowledgeBase`** (no agent round-trip, no LLM call for the v0 shape):
   - `kb.recall("yesterday email", { k: 5, source: 'gmail' })` (also outlook, icloud)
   - `kb.recall("today calendar", { k: 5, source: 'gcal' })` (also outlook-cal, icloud-cal)
   - `kb.recall("promised will send owe", { k: 5 })` — semantic search across all sources
2. **Format** to the PRD §8.2 shape using a tiny templating function in TS — three sections, max 3-5 bullets each, ≤ 2000 chars total to fit one Telegram bubble.
3. **Send** to the user's pocketclaw DM session via the existing `messaging_groups` + `delivery.ts` path. The host already knows how to deliver messages to a session — this is just `delivery.send(messagingGroupId, { text })` with the user's pocketclaw-DM messaging-group-id read from config.

If the user wants narrative prose instead of bullets, promote to an agent-driven version later (same trade-off as the wiki cron).

## Dependencies

- Knowledge base (done).
- Knowing the destination messaging-group-id at handler time. Either:
  - Add a `MORNING_DIGEST_DESTINATION` env var pointing at a messaging-group-id, OR
  - Convention: send to the agent group's "primary DM" (the first messaging-group wired with `session_mode='dm'`).

## Files that change

- New: `src/modules/morning-digest.ts` — gather + format + send.
- Edit: wherever the 07:00 cron is registered (search for `morning-digest` audit-log emit) — wire `morning-digest` as the handler.
- Edit: `.env.sample` if going with the env-var approach.
- Edit: `groups/pocketclaw/skills/digest/SKILL.md` — once wired, remove the NOT YET WIRED banner; keep `/digest` as the manual-trigger form.

## Acceptance

- Run cron manually via host tooling. Audit log: `morning-digest | OK | <bytes>`.
- Check the destination Telegram chat: morning-digest message arrives with the three sections.
- vitest: happy-path test that mocks `KnowledgeBase` + `delivery.send` and asserts the formatted message shape.

## Out of scope

- Per-day variation (different sections weekday vs weekend). Defer.
- User-tunable section ordering / inclusion. Defer.
- Quiet-hours / vacation suppression. Defer — user can disable the cron entirely.
