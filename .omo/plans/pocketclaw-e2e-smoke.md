# PocketClaw E2E Smoke

**Status:** STUB — codifies prereqs and known gaps surfaced during the M0-M7 wrap-up smoke probe (HEAD `c5efdfa`)
**Goal:** prove a single round-trip works end-to-end (operator sends a message → agent receives, runs `kb_recall`, replies) on a fresh checkout, headlessly enough that it can become a CI gate later
**Forward-linked from:** the M0-M7 KB rearch wrap-up — A1 in the ralph loop that surfaced this plan

## Why parked

A live smoke needs Bryan in the loop (Telegram identity), but a *headless* smoke via the local `cli` channel adapter is technically possible — except the load-bearing init scripts that `pnpm setup` and the per-channel adapters call are missing on `feature/pocketclaw-build`. Specifically:

- `scripts/init-cli-agent.ts` — referenced by `setup/cli-agent.ts:63`, `setup/auto.ts:404`, `setup/lib/claude-assist.ts:62`. Exists on tag `v2.0.54`, never landed on this branch.
- `scripts/init-first-agent.ts` — referenced by every channel adapter under `setup/channels/*.ts` (telegram, whatsapp, signal, slack, discord, teams, imessage). Same provenance — `v2.0.54` only.

`git merge-base feature/pocketclaw-build v2.0.54` returns empty: the two are unrelated lineages. Restoring either script is a separate work item with its own contract-drift risk; this plan does not assume either is fixed.

`data/v2.db` is gitignored and currently absent on disk. The host self-creates the file on first boot via `fs.mkdirSync(...recursive:true)` in `src/db/connection.ts:15` followed by `new Database(dbPath)` — but it boots into an empty schema with zero agent groups, zero messaging groups, and zero wirings. Without seed data, no message can be routed.

## Prereq matrix (current state, HEAD `c5efdfa`)

| # | Item | State | Notes |
|---|------|-------|-------|
| 1 | docker-compose pgvector service | ✅ runs, healthy | `pocketclaw-pg` on `127.0.0.1:5432`, trust auth, `vector(768)` migration applied on host start |
| 2 | Ollama with `nomic-embed-text` pulled | ❌ not running | Required for `kb.write/recall` embedding path; KB falls back to no-op without it (need to confirm fallback contract) |
| 3 | Agent container image built | ❌ not built | `pnpm exec tsx setup/index.ts --step container` — only Docker-runtime supported |
| 4 | `data/v2.db` seeded with one agent group + one wiring | ❌ no seed path on this branch | Either restore `init-cli-agent.ts` from `v2.0.54` OR write a new seeder; `groups/pocketclaw/container.json` already references `ag-1779335520163-gzrk2c` from a prior install but the row is gone |
| 5 | `.env` populated for the chosen channel | ⚠️ partial | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID`, `ANTHROPIC_API_KEY` present; no `CLAUDE_CODE_OAUTH_TOKEN` (OAuth-first guidance landed in `.env.sample` at `3c9bca4` but isn't required for headless cli-channel smoke) |
| 6 | Channel adapter for the smoke wired | ✅ registered | `src/channels/index.ts` imports `cli`, `telegram`, `whatsapp`. The `cli` channel does not need any external service. |

## Proposed shape (when prereqs are met)

A single Node script — `scripts/smoke-e2e.ts` — that exits 0 on success and non-zero on any failure step. Phases:

### Phase 1 — Boot

1. Spawn `pnpm dev` as a child process; capture stdout/stderr.
2. Wait until `[host] adapters initialized` (or equivalent) appears in stdout, with a 30s timeout.
3. Verify `data/v2.db` exists and has `migrations` table populated.

### Phase 2 — Seed sanity

1. Open `data/v2.db` read-only via `better-sqlite3`.
2. Assert: at least one row in `agent_groups`, one in `messaging_groups`, one in `messaging_group_agents`.
3. Resolve the `cli:local` mga's `id` for use in Phase 3 (no hardcoded IDs).

### Phase 3 — Inject + observe

1. Resolve the session for that mga (create if needed via the host's normal lazy-create path; do NOT touch `sessions` directly).
2. Write a single `messages_in` row with `kind='message'`, content `{ "type": "text", "text": "/recall coffee" }`, even-`seq`, `status='pending'`.
3. Poll the matching `outbound.db` for a row with `kind='message'` and content matching `/coffee/i` within 60s (allow for cold container start).
4. Verify the same session's `outbound.db` has at least one `kind='system'` row with `action='kb_request'` and a paired `inbound.db` row with `action='kb_response'` — proves the M0-M7 transport actually fired.

### Phase 4 — Teardown

1. SIGTERM the host; assert clean exit < 10s.
2. `docker compose stop` postgres (NEVER `down -v` — preserves volumes).
3. Print a one-line summary: `SMOKE OK round-trip=<ms> kb_request=<count>`.

## Dependencies

**Hard blocker:**
- Either `scripts/init-cli-agent.ts` restored from `v2.0.54` (and verified to still match HEAD's DB schema), OR a new seeder script that creates the same four rows (synthetic `cli:local` user, agent group, `cli/local` messaging group, mga wiring with `engage_mode='pattern'` `engage_pattern='.'`).

**Soft blocker (degrades coverage but does not prevent smoke):**
- Without Ollama, the `kb_recall` step in Phase 3 returns empty results. Smoke can still pass on a recall-with-no-results contract; document that and only assert the transport fires, not that meaningful results come back. Promote to a stricter assertion once Ollama is in the prereq.

## Files that change

- New: `scripts/smoke-e2e.ts` — the harness (~300 LOC)
- New: `groups/pocketclaw/skills/_smoke/SKILL.md` (or wherever skill stubs live for non-shipping flows) — operator-facing one-paragraph "how to run the smoke locally"
- Edit: `package.json` — add `"smoke": "tsx scripts/smoke-e2e.ts"` script
- Edit: `.omo/notepads/pocketclaw/phase3-resume.md` — mark E2E smoke plan written, link here
- Possibly: `scripts/init-cli-agent.ts` (separate plan if we go the restore route)

## Acceptance

- Fresh checkout: `pnpm install && docker compose up -d postgres && <seed step> && pnpm setup --step container && pnpm smoke` exits 0.
- The smoke completes in under 90 seconds on Bryan's host.
- Re-running `pnpm smoke` against an already-seeded DB still passes (idempotent).
- Vitest: at least one unit test for the seed-sanity helper against an in-memory DB; harness itself isn't unit-tested (it's the integration test).

## Out of scope

- Telegram or WhatsApp round-trips — those need the operator's account in the loop, can't be CI-gated headlessly without recorded fixtures (separate plan).
- Container image build verification beyond "does it start" — full agent-runner unit/integration tests live in `container/agent-runner/`.
- Multi-message conversation, scheduling, approvals — single round-trip only.
- Restoring `init-cli-agent.ts` and `init-first-agent.ts` — captured here as a hard blocker but the actual restore (or rewrite) is its own change.
- pgvector data hygiene (HNSW recall quality, embedding dim drift on model swap) — covered by the central-db-pg plan, not this one.

## Notes from the inspection that produced this plan

- `setup/index.ts` is a step dispatcher (not a wizard): `--step <name>` for each of `timezone | set-env | environment | container | register | pair-telegram | groups | whatsapp-auth | signal-auth | mounts | service | verify | onecli | auth | cli-agent`. Each step is independently runnable. This makes the smoke script's prereq-check phase straightforward — just probe each step's output artifacts.
- `src/channels/cli.ts` exists (9.9KB). The `cli` channel is shipped on this branch and does not need OAuth or external pairing. It's the right harness for a headless smoke.
- `src/modules/knowledge-base/pg-client.ts` runs migrations from `src/db/postgres-migrations/` idempotently with `IF NOT EXISTS` guards. Smoke can re-run without DB reset.
- The 142-vitest-failures count (mentioned in the resume notepad) is a separate triage; do NOT assume it correlates with smoke readiness.
