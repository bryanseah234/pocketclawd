# PocketClaw Knowledge Re-arch — Phase 3 Resume

Checkpoint written after Phases 1 and 2 committed and verified. Resume Phase 3
from this file in a fresh chat. Plan reference: `.omo/plans/pocketclaw-knowledge-rearch.md`.

## State at checkpoint

- Branch: `feature/pocketclaw-build`
- HEAD: `ced6a3f feat(kb): phase 2 - KnowledgeBase interface + pgvector implementation`
- Previous: `8ab2a53 feat(kb): phase 1 - add pgvector compose service + schema migration`
- Working tree: clean except untracked `.omo/ralph/` (pre-existing audit artifacts)
- Postgres: stopped (`docker compose stop postgres` already done; volume preserved)
- `node_modules/`: present, contains `pg@8.21.0` and `@types/pg@8.20.0`
- Test baseline (pre-Phase-3): **142 failed | 296 passed (438)**. The 142
  failures are all pre-existing (`data/v2.db` is missing — central SQLite
  was wiped during the rearch prep, restoration deferred to the follow-on
  `pocketclaw-central-db-pg.md` plan). Phase 3 must not increase this count.

## Host gotchas (read before doing anything)

- `delegate_task` subagents are NON-VIABLE on this Win host (their `terminal`
  routes through git-bash which fails with `0xC0000142` on every spawn, and
  they can't fall back to `execute_code`). Do everything inline.
- Use `subprocess.run(["powershell", "-NoProfile", "-Command", ...])` via
  `execute_code` for all shell. Direct `terminal` (bash) crashes; the
  `write_file`/`read_file`/`patch` tools also route through bash and crash —
  use `execute_code` with Python file ops instead.
- Node 22 binary lives at:
  `C:\\Users\\bryan\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenJS.NodeJS.22_Microsoft.Winget.Source_8wekyb3d8bbwe\\node-v22.22.3-win-x64\\node.exe`
  System node is v26 and crashes `better-sqlite3` (NODE_MODULE_VERSION
  mismatch). Always PATH-prepend the Node 22 dir before any `pnpm`/`tsx`
  invocation.
- `pnpm install` postinstall on `sharp` fails with a quoting bug
  (`'heck.js"' is not recognized`). It's a pre-existing red herring — sharp's
  runtime works, only its first-run download check script fails. Do NOT
  `pnpm install` again unless absolutely needed; if forced, run as a detached
  child via `Start-Process` and poll a logfile (the parent powershell session
  blocks for ~5 minutes due to stdio inheritance otherwise — the
  `Start-Process -RedirectStandard*` pattern leaks, see scratch scripts in
  `C:\\Users\\bryan\\AppData\\Local\\Temp\\_pcw_*`).
- Postgres up/down via `docker compose up -d postgres` / `docker compose stop postgres`.
  Container name is `pocketclaw-pg`. Use `docker exec -i pocketclaw-pg psql -U
  pocketclaw -d pocketclaw` for SQL, with the SQL fed via `Get-Content $f -Raw |`
  redirection (PowerShell quoting of multi-statement SQL is hostile —
  always tempfile + pipe).

## Phase 3 — what needs to happen

Plan §3.4 says "migrate 7 callers". Inspection found **8 callers** (plan was
slightly out of date; meeting-minutes.ts and research-report.ts were missing
from the list, mnemon-runner.test.ts is the 9th and gets deleted in Phase 4).

### Callers and their patterns

| File | Pattern | Mnemon calls | Replacement |
|---|---|---|---|
| src/modules/photo-processor.ts | write-only | `mnemon remember --photo` | `kb.store({text, source:'pocketclaw-photo', source_id:..., tags:[...], metadata:{...}})` |
| src/modules/chat-archive.ts | write-only | `mnemon remember` per chat msg | `kb.store({text, source:'<platform>-chat', source_id:msgId, tags:[...]})` |
| src/modules/pocketclaw.ts:mnemonRemember | write-only | `mnemon remember --no-diff` | `kb.store({text, source:'external', tags:[...]})` |
| src/modules/ingestion/scheduler.ts:defaultOnFact | write-only | `mnemon remember` per Fact | `kb.store({text:fact.text, source:fact.source, source_id:fact.sourceId, tags:[...]})` |
| src/modules/wiki-generator.ts:recallEntity | read-only | `mnemon recall --query --depth --format` | `kb.recall(entity, {k:30})` then format manually as text |
| src/modules/wiki-generator.ts:listEntities | read-only | `mnemon status` → `top_entities` array | **NEW METHOD: `kb.topEntities(limit)`** — see interface extension below |
| src/modules/meeting-minutes.ts:gatherContextFromMnemon | read-only | `mnemon recall <title> --limit 50` | `kb.recall(title, {k:50})` |
| src/modules/research-report.ts:gatherLocalSources | read-only | `mnemon recall <topic> --limit N` | `kb.recall(topic, {k:limit})` |
| src/modules/pocketclaw-wiring.ts:mnemonRecallText | read-only | `mnemon recall <q> --limit N` | `kb.recall(q, {k:limit})` then format |
| src/modules/pocketclaw.ts:runMnemonGc | gc | `mnemon gc --threshold 0.5 --limit 50` | **NEW METHOD: `kb.lowImportance(threshold, limit)`** |

### Interface extensions (required to migrate listEntities + runMnemonGc)

Add to `src/modules/knowledge-base/index.ts` (append to `KnowledgeBase` interface):

```ts
  /**
   * Return the most-frequently-occurring entities across all insights.
   * Used by wiki-generator to enumerate entities worth a wiki page.
   * Aggregates `unnest(entities)` and counts.
   */
  topEntities(limit?: number): Promise<Array<{ entity: string; count: number }>>;

  /**
   * Return insights below an importance threshold — candidates for GC.
   * Suggest-mode only; caller decides whether to forget().
   */
  lowImportance(threshold: number, limit?: number): Promise<Insight[]>;
```

Add to `src/modules/knowledge-base/pgvector.ts`:

```ts
  async topEntities(limit = 100): Promise<Array<{ entity: string; count: number }>> {
    const pool = getPool();
    const r = await pool.query<{ entity: string; count: string }>(
      `SELECT unnest(entities) AS entity, COUNT(*)::text AS count
         FROM insights
        WHERE entities IS NOT NULL AND array_length(entities, 1) > 0
        GROUP BY entity
        ORDER BY count DESC
        LIMIT $1`,
      [limit],
    );
    return r.rows.map((row) => ({ entity: row.entity, count: Number(row.count) }));
  }

  async lowImportance(threshold: number, limit = 50): Promise<Insight[]> {
    const pool = getPool();
    const r = await pool.query<DbInsightRow>(
      `SELECT id, text, embed_model, source, source_id, category, importance,
              entities, tags, metadata, created_at, updated_at
         FROM insights
        WHERE importance IS NOT NULL AND importance < $1
        ORDER BY importance ASC, created_at ASC
        LIMIT $2`,
      [threshold, limit],
    );
    return r.rows.map(rowToInsight);
  }
```

Add 2 new tests to `pgvector.test.ts` (mirror existing pattern with `kbtest` source).

### Tag → entities/tags migration rule

Mnemon used a flat `--tags` comma-separated string for everything. The KB
interface separates `entities: string[]` (proper nouns: people, places,
companies) from `tags: string[]` (categorical labels: 'pocketclaw',
'src:gmail', etc.). For migrated callers:

- Keep platform/source markers as `tags`: `pocketclaw`, `src:<platform>-chat`,
  `src:gmail`, `kind:group`, `kind:dm`.
- Move person/contact/company-name strings (when callers extract them) into
  `entities`. Most callers don't extract entities today — leave `entities: []`
  initially. Wiki generation works off accumulated entities once they start
  being populated by other paths (e.g. cloud ingesters that already do NER
  inside Fact).
- `category` is per-caller: `'photo'`, `'chat'`, `'fact'`, etc.

### Singleton accessor pattern (use everywhere)

Every caller should use the singleton, not construct its own KB:

```ts
import { getKnowledgeBase } from './knowledge-base/index.js';

// ...
const kb = await getKnowledgeBase();
await kb.store({ text, source: '...', source_id: '...', tags: [...] });
```

`getKnowledgeBase()` lazy-initialises the singleton on first call (runs migrations, opens pool). Created in Phase 2; check `src/modules/knowledge-base/index.ts` for the export name and reset-for-test helper.

### `mnemon remember --photo` flag

Mnemon had a `--photo` flag that tagged the insight as a photo description.
Replacement: set `category: 'photo'` and add `tags: ['kind:photo']`.

### `mnemon recall` JSON shape vs `kb.recall()` return shape

Old recall callers parsed mnemon's JSON output (`results: [{ insight: {
content, id } }]`). New recall returns `Insight[]` directly with `text`
(not `content`) and `id` as a number. Each caller's parsing block needs
rewriting — this is mostly mechanical but watch for:

- `meeting-minutes.gatherContextFromMnemon` returns `{ raw: string[], errors: string[] }` — map insights to their `.text`
- `research-report.gatherLocalSources` returns `{ sources: ResearchSource[], errors: string[] }` where `ResearchSource` has `id: string, content: string, source: string, occurredAt?: string` — map `Insight.id` (number) to string, `text` to `content`, use `created_at.toISOString()` for `occurredAt`. The `source` field on `ResearchSource` already matches `Insight.source`.
- `wiki-generator.recallEntity` returns a `string` formatted for prompt
  inclusion — concatenate `Insight.text` with newlines or hyphens.
- `pocketclaw-wiring.mnemonRecallText` returns a `string` of newline-separated bullets.

### Bedrock plumbing in pocketclaw-wiring.ts

`pocketclaw-wiring.ts` also has a Bedrock invocation at L41-L138 (`callBedrockModel` or similar) for the morning-digest prompt. **DO NOT touch this in Phase 3.** Phase 5 owns the Bedrock removal — replacing the digest backend with Claude Code subscription is a separate concern. Phase 3 only swaps `runMnemon` calls; leave the Bedrock function alone.

### Order to migrate

Patch in this order (low-risk → high-risk):

1. `chat-archive.ts` — fire-and-forget, no return value, smallest surface
2. `ingestion/scheduler.ts:defaultOnFact` — single function, simple text+tags
3. `photo-processor.ts:rememberInMnemon` — single function, photo flavour
4. `pocketclaw.ts:mnemonRemember` (used by file-watcher path) — also fire-and-forget
5. `meeting-minutes.ts:gatherContextFromMnemon` — first read-side caller
6. `research-report.ts:gatherLocalSources` — slightly more elaborate parsing
7. `pocketclaw-wiring.ts:mnemonRecallText` — last read-side caller
8. `wiki-generator.ts:recallEntity + listEntities` — the read+aggregate caller
9. `pocketclaw.ts:runMnemonGc` — gc caller, last because it depends on `lowImportance` interface extension

After each file: `tsc --noEmit`. Don't run vitest until all 9 caller patches are done — too slow per-iteration.

### After all 9 patches

1. Re-do interface extension (`topEntities`, `lowImportance`) BEFORE patching wiki-generator/runMnemonGc, or those typecheck calls fail.
2. Add 2 new tests in `pgvector.test.ts` for the new methods.
3. `tsc --noEmit` clean.
4. `docker compose up -d postgres` (wait for healthy).
5. Full vitest suite: must show **142 failed | 298 passed (440)** (i.e. +2 from Phase 2's 296, no new failures).
6. `docker compose stop postgres`.
7. Commit: `feat(kb): phase 3 - migrate callers from mnemon to KnowledgeBase`. Mention all 9 files in commit body. Reference §3.4 of plan, note interface extension (topEntities + lowImportance) as deviation from plan.

### What stays untouched in Phase 3

- `src/modules/mnemon-runner.ts` — Phase 4 deletes this file
- `src/modules/mnemon-runner.test.ts` — Phase 4 deletes this file
- `src/modules/pocketclaw-wiring.ts:callBedrock*` — Phase 5 owns Bedrock removal
- `setup.ps1`, `setup.sh`, `groups/pocketclaw/CLAUDE.md` — Phase 7 owns docs/setup
- `WHATSAPP_AUTH_DIR` env var introduction — Phase 6

## Resume command for fresh chat

> "Resume the PocketClaw knowledge re-arch ralph loop from `.omo/notepads/pocketclaw/phase3-resume.md`. P1 and P2 are committed at `8ab2a53` and `ced6a3f`. Execute Phase 3 inline (no subagents — they're broken on this host), one file at a time in the order specified, then commit. After Phase 3 commits cleanly, continue with Phase 4 (delete mnemon-runner) and onward through Phase 7."
