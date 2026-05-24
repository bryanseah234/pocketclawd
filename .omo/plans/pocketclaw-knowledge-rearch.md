# PocketClaw Knowledge Re-architecture

**Status:** DRAFT v2 — awaiting phase-order confirmation
**Author:** audit/ralph follow-up session
**Date:** 2026-05-24
**Tag for rollback:** `pre-audit-ralph-1` (pre-existing)

---

## 1. Why this plan exists

PocketClaw's current knowledge layer is built on **mnemon**: a single Go binary
(`mnemon.exe`) writing to a SQLite database at a hardcoded host path
(`~/.mnemon-pocketclaw/data/default/mnemon.db`). In live operation this caused
three classes of pain:

1. **SQLITE_BUSY storms** — concurrent `mnemon remember` calls under chat-archive
   load (Telegram backfill 1700+ messages) silently dropped writes. The CLI's
   "open DB → write → exit" pattern serialises poorly across N callers.
2. **Hardcoded host paths** — `MNEMON_DATA_DIR`, `MNEMON_DB_PATH`, `MNEMON_BIN`
   all encode Windows-specific filesystem layout into `.env`. Cross-platform
   setup is fragile (NTFS-only, Go binary install via `go install`).
3. **Naming coupling** — `src/modules/mnemon-runner.ts` names the implementation
   in the file itself, so swapping vendors requires file renames cascading into
   every caller.

Goal: replace the storage layer with **Postgres + pgvector** (single container
in `docker-compose.yml`), rename the seam to vendor-neutral, drop Bedrock from
PocketClaw entirely (use Claude Code subscription like nanoclaw default), and
make WhatsApp auth path configurable. Preserve Vivian Balakrishnan's
capture-layer-plus-curation-layer pattern — only the capture-layer storage
changes.

---

## 2. What stays the same

- **Obsidian wiki layer.** 03:00 cron still regenerates Markdown with WikiLinks.
  Only the source query changes (Postgres SELECT instead of `mnemon recall`).
- **Ollama for embeddings.** Host-side `ollama embed` call, stores returned
  vector in Postgres. Embedding model unchanged (`nomic-embed-text`).
- **Capture-layer API surface.** `store(insight)`, `recall(query, k)`,
  `related(id)`, `link(a, b)` — the verbs an agent calls don't change. Only the
  interface name and implementation behind it.
- **Vision pipeline (llava).** Photo → description → store as insight. The
  description-text path is unchanged; only the `store()` call points at the new
  backend.
- **Cron schedule.** 02:00 ingest, 03:00 wiki, 07:00 digest — unchanged.
- **Two-DB session split, channel adapters, host orchestrator.** Out of scope.

---

## 3. What changes

### 3.1 Storage backend

**Out:** mnemon (Go binary + SQLite at host path).
**In:** Postgres 16 with `pgvector` extension, running in `docker-compose.yml`,
listening on `localhost:5432`. No password (host-only access; trust auth on the
local Docker network).

`docker-compose.yml` gets one new service:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: pocketclaw-pg
    restart: unless-stopped
    ports:
      - "127.0.0.1:5432:5432"
    environment:
      POSTGRES_USER: pocketclaw
      POSTGRES_DB: pocketclaw
      POSTGRES_HOST_AUTH_METHOD: trust   # localhost-only, no password
    volumes:
      - pocketclaw-pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "pocketclaw"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pocketclaw-pg-data:
```

Bind to `127.0.0.1` so even if the user's firewall is misconfigured, the port
isn't exposed externally. `trust` auth is acceptable because the Postgres
process is reachable only from the host loopback (and from other containers on
the same compose network if we add them later).

### 3.2 Schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;          -- fuzzy text search

CREATE TABLE insights (
  id            BIGSERIAL PRIMARY KEY,
  text          TEXT NOT NULL,
  embedding     vector(768),                     -- nomic-embed-text dimension (FIXED for HNSW indexability)
  embed_model   TEXT NOT NULL,                   -- e.g. 'nomic-embed-text' — forensic record + drift detection
  source        TEXT NOT NULL,                   -- 'telegram', 'whatsapp', 'gmail', 'photo', etc.
  source_id     TEXT,                            -- platform-specific id for dedup
  category      TEXT,
  importance    INTEGER DEFAULT 5,               -- 1-10
  entities      TEXT[] DEFAULT '{}',
  tags          TEXT[] DEFAULT '{}',
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source, source_id)                     -- idempotency guard
);

CREATE INDEX insights_embedding_idx ON insights
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX insights_source_idx ON insights (source);
CREATE INDEX insights_created_idx ON insights (created_at DESC);
CREATE INDEX insights_text_trgm_idx ON insights USING gin (text gin_trgm_ops);
CREATE INDEX insights_embed_model_idx ON insights (embed_model);

CREATE TABLE edges (
  from_id       BIGINT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  to_id         BIGINT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                   -- 'related', 'caused-by', 'about-same-entity', etc.
  weight        REAL DEFAULT 1.0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (from_id, to_id, kind)
);

CREATE INDEX edges_to_idx ON edges (to_id);
```

The `UNIQUE (source, source_id)` constraint is the **idempotency guard** —
re-ingesting the same Telegram message won't duplicate. Use `INSERT ... ON
CONFLICT DO NOTHING` (or `DO UPDATE` for refreshing embeddings).

**Why `vector(768)` fixed + `embed_model` column?** pgvector's HNSW and IVFFlat
indexes both require a fixed dimension at index-creation time. `vector` with no
declared dimension is permitted but cannot be indexed — every recall becomes a
full table scan. At PocketClaw scale (1k–100k insights) that is a 10ms→1s
regression per query. The `embed_model` column gives us forensic clarity (we
can detect "wait, why does this row claim a different model?") without
sacrificing the index. A future model swap becomes an explicit 3-step
operation: `ALTER TABLE ... ALTER COLUMN embedding TYPE vector(<new_dim>)` (which
fails loudly if any row has the wrong dim, forcing re-embed first), re-embed
all rows, rebuild the HNSW index. We accept that re-embedding is the cost of
swapping models — there is no useful cosine distance between a 768-dim and a
1024-dim vector, so flexibility-without-re-embed is a chimera.

Migrations live at `src/db/postgres-migrations/NNN_*.sql`, run by a startup
hook in `src/index.ts` similar to existing SQLite migrations.

### 3.3 The `KnowledgeBase` interface

New file `src/modules/knowledge-base/index.ts`:

```ts
export interface Insight {
  id?: number;
  text: string;
  source: string;
  source_id?: string;
  category?: string;
  importance?: number;
  entities?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  // embed_model is set by the impl from the embedder it uses — callers do not supply it
  embed_model?: string;
}

export interface KnowledgeBase {
  store(insight: Insight): Promise<{ id: number; created: boolean }>;
  storeBatch(insights: Insight[]): Promise<{ ids: number[]; created: number }>;
  recall(query: string, opts?: { k?: number; source?: string; since?: Date }): Promise<Insight[]>;
  related(id: number, k?: number): Promise<Insight[]>;
  link(fromId: number, toId: number, kind: string, weight?: number): Promise<void>;
  forget(id: number): Promise<void>;
  count(filter?: { source?: string }): Promise<number>;
  close(): Promise<void>;
}
```

Implementation: `src/modules/knowledge-base/pgvector.ts` — the only concrete
binding for now. If/when we want to swap (Qdrant, Weaviate, sqlite-vec for
local dev), add another file behind the same interface; no caller changes.

The factory in `src/modules/knowledge-base/index.ts` reads `KB_BACKEND` env var
(default `pgvector`) and instantiates the right impl.

### 3.4 File renames (kill the vendor-named files)

| Old path                                   | New path                                          | Action |
| ------------------------------------------ | ------------------------------------------------- | ------ |
| `src/modules/mnemon-runner.ts`             | `src/modules/knowledge-base/pgvector.ts`          | rewrite content; delete old |
| `src/modules/mnemon-runner.test.ts`        | `src/modules/knowledge-base/pgvector.test.ts`     | rewrite content; delete old |
| (none)                                     | `src/modules/knowledge-base/index.ts`             | new — interface + factory |
| (none)                                     | `src/modules/knowledge-base/pg-client.ts`         | new — `pg` pool wrapper |
| (none)                                     | `src/modules/knowledge-base/embed.ts`             | new — Ollama embed call (extracted from inline) |
| `src/db/postgres-migrations/001_init.sql`  | (new)                                             | new — schema above |

All 208 grep hits for `mnemon` in `src/` get rewritten to use the
`KnowledgeBase` import. Most are in:

- `src/modules/pocketclaw-wiring.ts` — morning digest builder, ingestion calls
- `src/modules/pocketclaw.ts` — cron tick orchestration
- `src/modules/wiki-generator.ts` — 03:00 cron, regenerates Obsidian markdown
- `src/modules/photo-processor.ts` — vision pipeline writes
- `src/modules/ingestion/{google,microsoft,apple,file-watcher}.ts` — capture
- `src/modules/chat-archive.ts` — chat archival
- `src/modules/debouncer.ts` — does it touch mnemon? grep, may not

Container-side references (`container/skills/`, `container/agent-runner/src/`)
also need rewriting — agent-runner skills like `add-mnemon` get replaced with
`add-knowledge-base` skill that teaches the agent to use the new MCP tool
exposing the `KnowledgeBase` API.

### 3.5 Drop Bedrock plumbing

PocketClaw moves to nanoclaw's default Claude Code subscription model.

**Removed from `.env`:**
- `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_PROFILE`
- `CLAUDE_CODE_USE_BEDROCK`
- `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`

**Removed from disk:**
- `scripts/refresh-bedrock-creds.ps1` (already obsolete, scheduled task deleted)
- Any `if (CLAUDE_CODE_USE_BEDROCK)` branches in code

**Removed from CLAUDE.md (root):**
- The whole "AWS SSO two-layer credential model" section under PocketClaw notes
- The "Bedrock model availability" comment block
- `refresh-bedrock-creds.ps1` references

`docs/SERVICE.md` similarly trimmed.

Side benefit: setup.ps1 (next plan) becomes drastically simpler — no AWS SSO
login flow, no `aws configure sso`, no scheduled task for credential refresh.

### 3.6 WhatsApp auth path made configurable

Add to `.env`:

```
# Where Baileys stores its multi-file auth state. Survives data/ wipes.
WHATSAPP_AUTH_DIR=C:/Users/bryan/.pocketclaw/whatsapp
```

Update `src/channels/whatsapp.ts` to read `process.env.WHATSAPP_AUTH_DIR ||
path.join(os.homedir(), '.pocketclaw', 'whatsapp')` instead of hardcoded
`data/auth/whatsapp`. Default location is outside the repo, so future `data/`
nukes don't kill the WhatsApp pairing.

`mkdir -p` the dir on startup if missing (with `0700` perms on POSIX).

### 3.7 Ingestion idempotency now first-class

Today's mnemon path has loose dedup (text-hash-based, leaky under whitespace
changes). Postgres `UNIQUE (source, source_id)` constraint forces every
ingestor to declare a stable platform ID:

| Ingestor               | source_id derivation                         |
| ---------------------- | -------------------------------------------- |
| Telegram (bot/MTProto) | `<chat_id>:<message_id>`                     |
| WhatsApp (Baileys)     | message.key.id                               |
| Gmail                  | gmail message id                             |
| Outlook (MS Graph)     | message id                                   |
| iCloud (mail)          | Message-ID header                            |
| File-watcher           | SHA256 of file content                       |
| Photo-processor        | SHA256 of resized image                      |
| Manual (chat command)  | uuid v4                                      |

`INSERT ... ON CONFLICT (source, source_id) DO NOTHING` — re-ingesting is
free and safe. This kills a whole class of duplicate-write bugs at the DB
layer instead of in-app guards.

---

## 4. What to do with existing mnemon data

**Decision: fresh start. No migration.**

Justification:
- The previous `~/.mnemon-pocketclaw/` was deleted in the teardown turn before
  this conversation.
- The 1000 insights it held were largely chat archive + ingestion replay; they
  re-populate naturally as the system runs.
- Writing a one-shot ETL (mnemon SQLite dump → Postgres SELECT) for data the
  user has already chosen to nuke is busywork.

If you change your mind: write a `scripts/migrate-mnemon-to-pg.ts` later that
reads a mnemon DB file and bulk-inserts. Out of scope for this plan.

---

## 5. Implementation phases

Each phase is independently committable and reversible. **Do not start phase
N+1 until N is green (tsc + tests).**

### Phase 1 — Compose + schema (no code changes)

1. Add `postgres` service to `docker-compose.yml`.
2. Create `src/db/postgres-migrations/001_init.sql` with the schema in §3.2.
3. Add `pg` and `@types/pg` to `package.json`.
4. Document in `docs/SETUP.md` how to bring up the DB (`docker compose up -d
   postgres`).
5. Manual smoke: `psql -h localhost -U pocketclaw -d pocketclaw -c "SELECT
   1;"` works.

**Risk:** zero. Nothing in the code references the new DB yet.
**Rollback:** `docker compose down -v` and revert the compose file.

### Phase 2 — `KnowledgeBase` seam + pgvector implementation

1. Write `src/modules/knowledge-base/index.ts` (interface + factory).
2. Write `src/modules/knowledge-base/pg-client.ts` (`pg` pool, runs migrations
   on startup).
3. Write `src/modules/knowledge-base/embed.ts` (extracted Ollama call —
   currently inline in mnemon-runner).
4. Write `src/modules/knowledge-base/pgvector.ts` (concrete impl).
5. Write `src/modules/knowledge-base/pgvector.test.ts` covering: store,
   storeBatch (with conflict), recall (vector + filter), related, link,
   forget, count.
6. Tests run against a real Postgres on `localhost:5432` (Docker). No
   in-process mock — vector ops are too implementation-coupled.

**Risk:** zero. New files, no callers yet.
**Rollback:** delete the new directory.

### Phase 3 — Migrate callers

Each caller migrates one file at a time. After each: tsc green, touched test
suites green, commit.

Order (lowest blast radius first):
1. `src/modules/photo-processor.ts` (single capture path)
2. `src/modules/wiki-generator.ts` (single read path, 03:00 cron)
3. `src/modules/chat-archive.ts`
4. `src/modules/ingestion/{google,microsoft,apple,file-watcher}.ts`
5. `src/modules/pocketclaw-wiring.ts` (digest builder, multi-call)
6. `src/modules/pocketclaw.ts` (cron orchestrator — last because most refs)

Each migration replaces `import { ... } from './mnemon-runner'` with
`import { getKnowledgeBase } from './knowledge-base'` and updates call sites.

**Risk:** moderate per-file. Mitigated by phased commits.
**Rollback:** revert the offending commit.

### Phase 4 — Delete mnemon-runner

1. Confirm zero imports of `./mnemon-runner` remain (`grep -r mnemon-runner
   src/`).
2. Delete `src/modules/mnemon-runner.ts` and `src/modules/mnemon-runner.test.ts`.
3. Delete `src/modules/add-mnemon` skill if present.
4. Strip `MNEMON_*` env vars from `.env` (and `.env.example` if exists).
5. Strip `mnemon` references from CLAUDE.md, docs/, README.md.

**Risk:** zero if Phase 3 was complete.
**Rollback:** git revert.

### Phase 5 — Drop Bedrock

1. Strip `AWS_*`, `CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_MODEL`,
   `ANTHROPIC_SMALL_FAST_MODEL` from `.env`.
2. Find every `if (process.env.CLAUDE_CODE_USE_BEDROCK)` branch in `src/` and
   `container/`; remove the bedrock branch, keep the subscription branch.
3. Delete `scripts/refresh-bedrock-creds.ps1`.
4. Trim CLAUDE.md and `docs/SERVICE.md` of Bedrock content.
5. Verify container boots without AWS env vars.

**Risk:** moderate — the host's container-runner injects env vars into the
agent container; missing vars must not crash startup.
**Rollback:** git revert (don't recreate the scheduled task — it's already
deleted).

### Phase 6 — WhatsApp auth path

1. Add `WHATSAPP_AUTH_DIR` to `.env` with sensible default.
2. Update `src/channels/whatsapp.ts` to read env var with fallback to
   `~/.pocketclaw/whatsapp/`.
3. `mkdir -p` with mode `0700` on POSIX, default ACL on Windows.
4. Document in `docs/POCKETCLAW.md` that this path survives `data/` wipes.

**Risk:** low. Existing pairings in `data/auth/` are already gone (teardown).
On first re-pair, Baileys writes to the new location.
**Rollback:** revert; default falls back to old `data/auth/whatsapp/` path.

### Phase 7 — Final cleanup

1. Delete `repo-tokens/` directory (vendored badge action, irrelevant).
2. Trim CLAUDE.md PocketClaw section: remove mnemon, remove Bedrock, add
   pgvector + Claude subscription notes.
3. Update `docs/SETUP.md` and `docs/POCKETCLAW.md` for the new architecture.
4. Bump CLAUDE.md "Active branch convention" if branch name changes.

---

## 6. File-by-file impact summary

**Created:**
- `src/modules/knowledge-base/index.ts`
- `src/modules/knowledge-base/pg-client.ts`
- `src/modules/knowledge-base/embed.ts`
- `src/modules/knowledge-base/pgvector.ts`
- `src/modules/knowledge-base/pgvector.test.ts`
- `src/db/postgres-migrations/001_init.sql`
- `docker-compose.yml` gets new `postgres` service (file may already exist)

**Renamed/rewritten:**
- `src/modules/mnemon-runner.ts` → deleted (replaced by `knowledge-base/pgvector.ts`)
- `src/modules/mnemon-runner.test.ts` → deleted (replaced by `pgvector.test.ts`)

**Modified (caller migrations):**
- `src/modules/photo-processor.ts`
- `src/modules/wiki-generator.ts`
- `src/modules/chat-archive.ts`
- `src/modules/ingestion/google.ts`
- `src/modules/ingestion/microsoft.ts`
- `src/modules/ingestion/apple.ts`
- `src/modules/ingestion/file-watcher.ts`
- `src/modules/pocketclaw-wiring.ts`
- `src/modules/pocketclaw.ts`
- `src/modules/debouncer.ts` (pending grep verification)

**Modified (Bedrock removal):**
- `.env` (env var deletions)
- `container/agent-runner/src/providers/claude.ts` (drop Bedrock branch)
- `src/container-runner.ts` (drop AWS env injection)
- CLAUDE.md (root)
- `docs/SERVICE.md`
- Possibly `setup/` files

**Modified (WhatsApp path):**
- `src/channels/whatsapp.ts`
- `.env` (new var)

**Deleted:**
- `scripts/refresh-bedrock-creds.ps1`
- `repo-tokens/` (entire directory)
- `.claude/skills/add-mnemon/` (skill no longer relevant)
- Container skill `container/skills/add-mnemon/` if exists

**Total estimated diff:** ~15-20 files modified, ~5 files created, ~5 files deleted.
Ballpark +600/-400 lines.

---

## 7. Testing strategy

**Unit / integration:**
- `pgvector.test.ts` runs against real Postgres via `docker compose up -d
  postgres` in test setup. Cleans up by truncating tables in `afterEach`.
- Caller tests get updated to mock the `KnowledgeBase` interface, not the old
  mnemon runner.

**End-to-end smoke:**
1. Bring up Postgres compose service.
2. Run host with no agent.
3. Manually call `kb.store({ text: "test", source: "manual", source_id: "1" })`.
4. `kb.recall("test")` returns it with similarity score.
5. `kb.store(...)` again with same `source_id` → no-op (conflict).
6. Wiki regen cron generates Markdown from the test insight.

**Migration validation:**
- `pnpm build` green.
- `pnpm exec tsc --noEmit` green.
- `pnpm exec vitest run` ≥ 385 passing (the established floor).
- Manual chat round-trip via Telegram/WhatsApp once host is restarted.

---

## 8. Risks and unknowns

1. **`pg` driver on Windows + better-sqlite3 coexistence.** PocketClaw uses
   `better-sqlite3` for `data/v2.db` and per-session DBs. Adding `pg` is
   additive — no native compile conflict expected, but verify on first
   `pnpm install`.
2. **Postgres on exFAT.** The Postgres data dir lives in the Docker volume
   `pocketclaw-pg-data`, which Docker Desktop stores under
   `%LOCALAPPDATA%\Docker\wsl\` (NTFS). Not exFAT. ✓ safe.
3. **HNSW index build on first large insert.** Cold start with thousands of
   rows might pause for seconds during index build. Negligible for PocketClaw
   scale.
4. **Embedding dimension drift.** Mitigated by storing `embed_model` on every
   row (§3.2). If you change `OLLAMA_EMBED_MODEL`, the `vector(768)` column
   forces an explicit `ALTER TABLE` migration that fails loudly until every
   row is re-embedded with the new model. No silent corruption. Re-embed
   procedure: bring up a side table with `vector(<new_dim>)`, batch-embed
   from `text` column, atomic swap, drop old. Documented in
   `docs/POCKETCLAW.md` once landed.
5. **Vivian-pattern fidelity.** The capture-layer-plus-curation-layer pattern
   survives. The semantic difference: mnemon's "edges" were heuristic; with
   pgvector + explicit `edges` table, you get the same model but with
   declarative SQL queries instead of opaque CLI calls. No regression.
6. **Setup friction for new contributors.** "Run docker compose up -d
   postgres" must be in `docs/SETUP.md`. Otherwise host startup fails with
   ECONNREFUSED on 5432. Auto-start the compose service from a setup script
   is a follow-on (the onboard plan).

---

## 9. Out of scope (separate plans)

- **Cross-platform setup script** (`setup.ps1` for Windows, `setup.sh` for
  Mac/Linux) — written in `.omo/plans/pocketclaw-onboard.md` after this plan
  lands.
- **Distributed/persistent cron.** Today's `pocketclaw.ts tick()` is OS-pause
  vulnerable (lower-tier audit finding deferred). Not addressed here.
- **WhatsApp test coverage gap.** No `whatsapp.test.ts` exists. Pre-existing.
- **Container skill rewrites for agent-runner side.** Will be covered as
  caller migrations within Phase 3 if needed; otherwise a follow-on.
- **Migrating `data/v2.db` SQLite → Postgres.** Deferred to a separate plan,
  `.omo/plans/pocketclaw-central-db-pg.md`, written *after* this rearch
  lands and Postgres is proven in production on this machine. Two paths exist
  there:
    - **Path X** (recommended next): central DB only — `users`, `agent_groups`,
      `wirings`, `pending_*`, `container_configs` move to Postgres. Per-session
      `inbound.db` / `outbound.db` stay as SQLite files mounted into containers.
      Hybrid storage, but the load-bearing two-DB session split (CLAUDE.md
      "Exactly one writer per file — no cross-mount lock contention") is
      preserved.
    - **Path Y** (further future, possibly never): per-session DBs also become
      Postgres. Requires re-implementing the even-seq/odd-seq split with
      advisory locks or per-session connections; breaks the journal_mode=DELETE
      cross-mount assumption. Real architectural rewrite. Only justified if
      multi-machine deployment ever becomes a goal.
  
  Sequencing rationale: land knowledge rearch → validate Postgres health and
  backups for ~2 weeks of normal operation → land Path X as a focused follow-up
  → revisit Path Y only if pain emerges. Bundling either into this plan would
  balloon the diff and conflate two genuinely different engineering concerns
  (knowledge storage vs host↔container IPC).

---

## 10. Approval gate

This plan is ready for review. Decisions locked in:
- pgvector + Postgres-no-password (✓ agreed).
- `vector(768)` fixed + `embed_model` column for forensic clarity (✓ agreed —
  preserves HNSW index, swap cost paid only on actual model change).
- No migration of existing mnemon data (§4).
- Central DB → Postgres deferred to a separate post-rearch plan (§9, ✓ agreed).
- Phase order (§5) — smallest blast radius first; flag now if you want it
  flipped.
- `repo-tokens/` and `add-mnemon` skill killed in cleanup (Phase 7).

Open: confirm phase order in §5 is acceptable.

Once approved, work proceeds on a new branch `feature/kb-pgvector` cut from
`feature/pocketclaw-build`. Each phase = one or more commits. No squash;
preserve the audit trail.

---

## 11. Done criteria

- [ ] `docker compose up -d postgres` brings up a working pgvector instance.
- [ ] No file in `src/` or `container/` references `mnemon` (verified by
      `grep -r mnemon src/ container/` returning empty, modulo CHANGELOG).
- [ ] No env var beginning with `MNEMON_` or `AWS_` or `BEDROCK` remains in
      `.env` or any code path.
- [ ] `WHATSAPP_AUTH_DIR` is read from env with a sensible default outside
      `data/`.
- [ ] Wiki regeneration produces Obsidian-compatible markdown from Postgres
      insights (manual smoke).
- [ ] `pnpm exec tsc --noEmit` green.
- [ ] `pnpm exec vitest run` ≥ 385 passing (floor preserved).
- [ ] CLAUDE.md, docs/SETUP.md, docs/POCKETCLAW.md updated to match reality.
- [ ] `repo-tokens/` deleted.
