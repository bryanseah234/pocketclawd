# PocketClaw KB MCP Tool + Skills Rewrite

**Status:** DRAFT — awaiting sign-off before ralph
**Branch:** `feature/pocketclaw-build`
**Depends on:** Knowledge-base rearch P1-P7 (landed at `7cf415b`)
**Unblocks:** wiki-regen cron rewire, morning-digest handler, every
`groups/pocketclaw/skills/*.md` slash-command.

---

## 1. The gap

The agent runs in a container; the `KnowledgeBase` is host-side TypeScript.
Today there is no transport between them, so:

- Every `groups/pocketclaw/skills/*.md` skill that says
  "call `mnemon remember/recall/...`" is dead instruction.
- The `wiki-regen` (03:00) and `morning-digest` (07:00) crons are
  `SKIP \| no-handler` / `SKIP \| no-provider` in the audit log.
- `chat-archive`, `photo-processor`, and the cloud `scheduler` all write to
  the KB *from the host*, but the agent itself cannot read or write.

This plan adds the missing transport using the **same pattern**
NanoClaw already uses for scheduling: the container issues a
**system action** via `messages_out`, the host executes it during
delivery, and (for read tools) the host writes the result back into
`inbound.db` for the next container poll to pick up.

Reference precedent: `container/agent-runner/src/mcp-tools/scheduling.ts` +
`src/delivery.ts` system-action handler.

## 2. Design

### 2.1 Tool surface (in-container)

`container/agent-runner/src/mcp-tools/kb.ts` registers five tools:

| Tool | Args | Returns (text content) |
|---|---|---|
| `kb_remember` | `text: string`, `source?: string`, `tags?: string[]`, `entities?: string[]` | `Stored insight #<id>` (or `Updated insight #<id>` on dedup hit) |
| `kb_recall` | `query: string`, `k?: number = 5`, `source?: string`, `since?: string (ISO)` | Numbered list: `[1] <text>  (source=<s>, score=<f>)` |
| `kb_list_top_entities` | `limit?: number = 10` | Numbered list: `[1] <entity> (<count> insights)` |
| `kb_status` | none | `Insights: <n> total, <n> with embeddings. Top sources: <list>. Top entities: <list>.` |
| `kb_forget` | `id: number` | `Forgot insight #<id>` (write-tool, requires confirm flag in v2) |

All five are registered the same way `scheduling.ts` does: import-side-effect
in `container/agent-runner/src/mcp-tools/index.ts`, plus a sibling
`kb.instructions.md` whose path is symlinked into
`groups/pocketclaw/.claude-fragments/skill-kb.md` so it lands in the agent's
prompt automatically.

### 2.2 Transport: messages_out system action

For each tool call the in-container handler writes a row into
`outbound.db`/`messages_out` with `kind='system'` and a body:

```json
{ "action": "kb_request",
  "request_id": "kb-1737-abc123",
  "tool": "kb_remember",
  "args": { "text": "...", "source": "agent-memory", "tags": [...] } }
```

Then it **blocks on the response**: polls `inbound.db`/`messages_in`
directly via a sidecar query for a matching row with `kind='system'`
AND `content` containing both `"action":"kb_response"` and the
request_id. Timeout: 15s; on timeout, return `{ isError: true }`.

**Critical detail confirmed during M0 scoping:** the container poll
loop (`container/agent-runner/src/poll-loop.ts:73`) already filters
`kind === 'system'` rows out before the agent sees them, so kb_response
rows never reach the agent's prompt or formatter. We reuse the existing
`system` kind (no schema or `MessageInKind` widening) and rely on the
MCP tool's sidecar reader to fish out the response.

This is a synchronous request/response pattern layered on top of the
async two-DB seam. The agent SDK makes the tool call sync from the
agent's POV (one MCP call → one result), the underlying DB exchange
is two writes + one read.

### 2.3 Host-side handler

New file: `src/kb-actions.ts` plus a hook in `src/delivery.ts`:

- `delivery.ts` already filters system actions (`schedule_task`, etc.). Add
  a `kb_request` branch that calls `handleKbRequest(action, sessionId)`.
- `kb-actions.ts` resolves `getKnowledgeBase()`, dispatches by `action.tool`,
  and writes a `kb_response` row to that session's `inbound.db`/`messages_in`
  with the same `request_id`.
- Errors get serialised: `{ ok: false, error: "<message>" }` body.
- Audit-logged: every `kb_request` and `kb_response` recorded in the
  audit log with `(session_id, request_id, tool, latency_ms, error?)`.

### 2.4 Permission model

The KB is per-host-user; PocketClaw's only user is Bryan. So **no
per-agent ACLs in v1.** Hard-code: any session belonging to the
`pocketclaw` agent group can call any `kb_*` tool. Other agent groups
have the tools registered but the host handler refuses with
`Error: kb_* tools are restricted to the pocketclaw agent group.`

Future (out of scope): scoped tags, per-agent-group source filtering.

### 2.5 Skill rewrites

After the tool ships, rewrite every skill in `groups/pocketclaw/skills/`:

| Skill | Old | New |
|---|---|---|
| `memory/SKILL.md` | `mnemon remember "<fact>"` | `kb_remember(text=<fact>, source="agent-memory")` |
| `recall/SKILL.md` | `mnemon recall --query "<q>"` | `kb_recall(query=<q>, k=5)` |
| `wiki/SKILL.md` | `WikiGenerator.generateEntry(...)` from agent (impossible) | (defer — wiki-regen needs cron-side rewire, separate plan) |
| `ingest/SKILL.md` | `CloudScheduler.runAll()` from agent (impossible) | Mark "host-only; use the 02:00 cron" — agent acknowledges, suggests `/status` |
| `digest/SKILL.md` | mnemon-recall combos | (defer — needs morning-digest handler) |
| `status/SKILL.md` | `mnemon status` shell call | `kb_status` MCP call |
| `audit/SKILL.md` | reads `/tmp/audit.log` (mounted) | unchanged — file is already mounted |
| `photo/SKILL.md` | `mnemon remember --photo` | `kb_remember(text=<desc>, source="manual-photo")` |
| `auth/SKILL.md` | unchanged | unchanged (no KB calls) |
| `minutes/SKILL.md` | imports `MeetingMinutesGenerator` from agent (impossible) | Defer — separate "agent-side .docx generation" plan |
| `research/SKILL.md` | imports `ResearchReportGenerator` from agent (impossible) | Defer |
| `slides/SKILL.md` | imports `SlideGenerator` from agent (impossible) | Defer |
| `speech/SKILL.md` | pure agent prompting | unchanged (already module-free) |

Skills marked **defer** get a clear `Status: not yet wired` block and a
forward reference to the relevant follow-on plan, instead of pretending
to work. No more dead instructions.

## 3. Phased ralph plan

Each phase ends with `pnpm exec tsc --noEmit` clean and a commit.
Vitest baseline must not regress (current floor: 273 passing).

| Phase | Work | Verification |
|---|---|---|
| **M0** | Add `src/kb-actions.ts` skeleton: dispatch table for `kb_request` actions, calls `getKnowledgeBase()`, writes `kb_response` to `messages_in`. Unit test against a stub KB. Hook into `delivery.ts` system-action filter. | tsc clean; `kb-actions.test.ts` green. |
| **M1** | Add `container/agent-runner/src/mcp-tools/kb.ts` with the five tool definitions + the request/response wait helper. Add to `mcp-tools/index.ts` barrel. Add `kb.instructions.md` sibling. | tsc clean; mcp-tools list shows the five new tools when starting an agent locally. |
| **M2** | End-to-end smoke: spawn a session, call `kb_remember` → expect a row in pgvector; call `kb_recall` → expect the row back; call `kb_status` → expect counts. | Manual smoke; add an integration test if cheap. |
| **M3** | Permission gate: refuse `kb_*` outside the `pocketclaw` agent group. Audit log entries for every request. | Test with a second dummy agent group → expect refusal. |
| **M4** | Symlink `kb.instructions.md` into `groups/pocketclaw/.claude-fragments/` so it lands in the system prompt. Update `groups/pocketclaw/CLAUDE.md` composer if needed. | Verify the prompt fragment appears when a session spawns. |
| **M5** | Rewrite skills: `memory`, `recall`, `status`, `photo`. (The four that the new tool actually serves.) | Manual: invoke each from Telegram, confirm correct behaviour. |
| **M6** | Rewrite `ingest` (host-only acknowledgement) and `audit` (no-op cleanup) skills. Mark `wiki`, `digest`, `minutes`, `research`, `slides` as `Status: not yet wired` with forward links. `auth` and `speech` left alone. | Smoke: each skill, verify reply matches the new instructions. |
| **M7** | Final `pnpm exec tsc --noEmit` + `pnpm exec vitest run` + cleanup commit. Update `CLAUDE.md` (root) to mention the kb tool family. | tsc clean; vitest >= 273 passing. |

Per-phase commits:
- `feat(kb-mcp): M0 host-side kb_request handler`
- `feat(kb-mcp): M1 in-container kb_* MCP tools`
- `feat(kb-mcp): M2 end-to-end smoke`
- `feat(kb-mcp): M3 permission gate + audit log`
- `feat(kb-mcp): M4 wire prompt fragment`
- `docs(skills): M5 rewrite memory/recall/status/photo`
- `docs(skills): M6 rewrite ingest/audit, defer wiki/digest/minutes/research/slides`
- `chore(kb-mcp): M7 final tsc + cleanup`

## 4. Risks

1. **DB race on response wait.** The polling helper must use the same
   `seq` parity rules as other DB writers (host even, container odd) and
   tolerate races against the regular agent-loop poll. Mitigation:
   reuse the existing `getPendingMessages` filter and add a
   `body.action='kb_response'` predicate that the agent loop ignores.
2. **15s timeout too tight for `kb_recall` over large pgvector.** HNSW
   search is sub-100ms at PocketClaw scale, but cold-start of pg pool
   could push past 15s on first call. Mitigation: warm the pool at
   host startup (already done via `getKnowledgeBase()` invocation in
   `chat-archive.ts`).
3. **Permission gate vs onecli `selective` secret-mode.** Unrelated
   surface — the kb gate runs entirely in `delivery.ts`/`kb-actions.ts`,
   no onecli touch. Mitigation: don't conflate the two.
4. **Skill rewrites land before tool ships.** Don't. M0-M4 must be
   green before M5-M7. Plan enforces ordering.

## 5. Out of scope

- Wiki-regen cron rewire (separate plan: would call `WikiGenerator`
  from the host handler on a schedule, write to vault path).
- Morning-digest handler (separate plan: needs `kb_recall` against
  multiple windows, then a `send_message` to the user-DM session).
- Agent-side .docx/.pdf/.pptx generation (`minutes`, `research`,
  `slides` skills). Each would need its own MCP tool family for
  large-binary file delivery — meaningful design work.
- Tag/source ACLs per agent group (v1 hard-codes pocketclaw-only).

## 6. Sign-off checklist

- [ ] User confirms tool surface (`kb_remember`/`kb_recall`/`kb_list_top_entities`/`kb_status`/`kb_forget`).
- [ ] User confirms request/response over `messages_out`/`messages_in` (vs adding a separate transport).
- [ ] User confirms hard-coded pocketclaw-only permission for v1.
- [ ] User confirms which skills get rewritten (M5-M6) vs deferred.
- [ ] User confirms commit message convention (`feat(kb-mcp): M<n> ...`, `docs(skills): M<n> ...`).
