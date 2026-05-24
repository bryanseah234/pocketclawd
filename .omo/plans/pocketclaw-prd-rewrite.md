# PocketClaw PRD — From-Scratch Rewrite

**Status:** DRAFT — awaiting sign-off before ralph
**Author/Owner:** PocketClaw rearch
**Branch:** `feature/pocketclaw-build`
**Replaces:** `PRD.md` v3.0 (123 mnemon/Bedrock hits, written before the rearch)

---

## 1. Why a from-scratch rewrite

The existing `PRD.md` (123,624 chars, 18 sections + appendices) is a v3.0 product
spec written **before** the knowledge-base rearch. It describes:

- mnemon as the memory engine (gone — now `KnowledgeBase` over Postgres + pgvector)
- AWS Bedrock as the Claude transport (gone — now Claude Code subscription via OneCLI)
- Python ingesters (gone — now TypeScript ingesters in `src/modules/ingestion/`)
- Slash-commands handled "by the agent" (the agent has no transport into the KB today;
  `wiki-regen` and `morning-digest` crons are `SKIP | no-handler` in the audit log)
- An Obsidian "vault" as a primary interface (it is still in `src/modules/wiki-generator.ts`
  but the regen cron is stubbed)

A surgical patch (mnemon → KnowledgeBase, drop Bedrock paragraphs) leaves the
document architecturally honest in some places and fictional in others. The PRD's
implementation phases (§13) describe building things that are already built;
§17–18 catalogue extended features whose runtime wiring is partly stubbed.

**Goal of this rewrite:** ship a PRD that reflects the code that exists today, marks
what is stubbed/aspirational explicitly, and stays useful as a product reference.

## 2. Truthful inventory (what is actually built)

The rewrite is grounded in this inventory, sourced from `git ls-files` +
`pnpm exec tsc --noEmit`:

### 2.1 Capture layer (working today)

- `src/modules/knowledge-base/` — `KnowledgeBase` interface (`index.ts`),
  pgvector implementation (`pgvector.ts`), Ollama embedding client (`embed.ts`),
  pg pool (`pg-client.ts`).
- `src/db/postgres-migrations/001_init.sql` — `(source, source_id)` upsert key,
  `vector(768)` + `embed_model` column, HNSW index.
- `docker-compose.yml` — single Postgres service, 127.0.0.1:5432, no password.
- `src/modules/photo-processor.ts` — vision pipeline (validate → resize →
  describe via Ollama llava → kb.store → cleanup). Idempotent on
  SHA256 of resized image.
- `src/modules/chat-archive.ts` — every inbound message archived into the KB
  via `kb.store` with `(source='chat', source_id=<msg-id>)`.
- `src/modules/debouncer.ts` — 5s message-batch queue, stickers silently dropped.

### 2.2 Cloud ingestion (working today)

- `src/modules/ingestion/scheduler.ts` — `Promise.allSettled` parallel run with
  fault isolation. **Default `onFact` writes to `KnowledgeBase`.**
- 5 ingester families: `google.ts` (Gmail/Calendar/Contacts), `microsoft.ts`
  (Outlook/Calendar/Contacts), `apple.ts` (iCloud Mail/Calendar/Contacts),
  `github.ts` (PRs/commits/issues), `slack.ts`.
- `src/modules/ingestion/file-watcher.ts` — watchdog with SHA256 idempotency.
- `src/modules/ingestion/telegram-mtproto.ts` — Telegram personal-account scrape.

### 2.3 Channels (working today)

- `src/channels/telegram.ts` — Chat SDK adapter; bot polling.
- `src/channels/whatsapp.ts` — Baileys; shared-number mode (bot=#…),
  `WHATSAPP_AUTH_DIR` env var, `WHATSAPP_OWNER_ALIASES` for summon.
- `src/channels/cli.ts` — terminal channel.
- Telegram pairing + markdown-sanitize helpers.

### 2.4 Agent infrastructure (working today, NanoClaw v2 inheritance)

- Per-session container model (two-DB split: `inbound.db` host→container,
  `outbound.db` container→host).
- MCP tools served by `container/agent-runner/src/mcp-tools/`:
  `core` (send_message etc.), `scheduling`, `interactive`, `agents`, `self-mod`.
- OneCLI gateway for credentialed actions.
- Claude provider via `ANTHROPIC_BASE_URL` + OneCLI auth-header rewrite
  (Bedrock branch removed in `feat(kb): phase 5`).

### 2.5 Curation layer (partially built / partially stubbed)

| Feature | Module exists | Wired to runtime | Status |
|---|---|---|---|
| Wiki generator | `src/modules/wiki-generator.ts` | No (cron is `SKIP \| no-provider`) | **Stubbed** |
| Meeting minutes (.docx) | `src/modules/meeting-minutes.ts` | No (skill instructs agent, but agent has no KB transport) | **Aspirational** |
| Research report (.pdf) | `src/modules/research-report.ts` | No (same) | **Aspirational** |
| Slide generator (.pptx) | `src/modules/slide-generator.ts` | No (same) | **Aspirational** |
| Speech draft (.md) | None — pure agent prompting in skill | N/A | **Aspirational** |
| Morning digest (07:00) | None | No (cron is `SKIP \| no-handler`) | **Stubbed** |

### 2.6 Slash-commands (the gap)

`groups/pocketclaw/skills/*.md` exist for: memory, recall, wiki, ingest, digest,
status, audit, photo, auth, minutes, research, slides, speech.

**Today** the skill texts tell the agent to invoke the `mnemon` CLI, which no
longer exists. The agent runs in a container with no transport into the
host-side `KnowledgeBase`. **No slash-command actually works end-to-end.**

The companion plan `pocketclaw-kb-mcp-tool.md` closes this gap by adding a
`kb_*` MCP tool family using the existing `messages_out` system-action pattern
(see scheduling.ts for precedent). The PRD must reflect that intent without
pretending the wiring is already there.

## 3. Target structure

The new PRD keeps the old document's high-level shape (vision → users → arch →
components → security → testing → phases → risks → appendices) but is grounded
in what runs today. Length target: ~30–40k chars (down from 124k); kill the
embedded code blocks that duplicated source files.

```
1.  Product Vision
2.  User Stories                           (trim: drop fictional users; keep 4-5 grounded)
3.  Goals and Non-Goals
4.  Success Metrics                        (mark which are instrumented vs aspirational)
5.  Competitive Analysis                   (keep — still useful)
6.  System Architecture                    (replace mnemon diagram with KB diagram; show host/container split)
7.  Component Specifications               (sourced from §2 inventory above)
8.  UX/Interaction Design                  (slash-commands marked "wired" / "pending kb-mcp-tool")
9.  Security Architecture                  (drop AWS_*; OneCLI section; .env minimum set)
10. Data Flow                              (message → debouncer → archive → kb → recall → response; ingestion → kb → wiki cron)
11. Testing Strategy                       (cite the actual test files; vitest baseline)
12. Cross-Platform Environment             (Windows host on Scheduled Task; pnpm/Node 22)
13. Implementation Phases                  (replace fictional Python phases with the rearch phases that actually shipped 1-7, plus pending: kb-mcp-tool, wiki-cron-rewire, digest-handler)
14. Risks & Mitigations
15. Non-Functional Requirements
16. Open Items & Future Work               (consolidates today's "stubbed" + "aspirational" rows)
17. (removed — old "extended features" — folded into §7 + §8 with honest status)
18. (removed — old "as-built" — same)
Appendix A: Glossary                       (drop mnemon/Bedrock terms; add KB/pgvector)
Appendix B: Environment Variable Reference (truthful: from src/env.ts + .env.sample)
Appendix C: File Structure                 (regenerated from src/ tree)
```

## 4. Voice / convention rules

- Prose tense: **present** for what is built, **future ("will")** for what is planned, **past** never.
- No code blocks longer than 15 lines. Reference `src/modules/<file>.ts` instead.
- Every "feature" claim links to a module path or marks `(stubbed)` / `(aspirational, pending kb-mcp-tool)`.
- No marketing copy ("AI-powered", "intelligently"). PocketClaw is for the user; the PRD is internal.
- Vivian Balakrishnan capture+curation pattern remains the architectural north star
  and is named in §1 and §6.
- Drop Singapore/DBS/Sarah-Chen narrative from the old §2 user stories; the user
  is "Bryan" (PocketClaw's actual single user) and the stories are grounded in
  current behaviour.

## 5. Phased ralph plan

Each phase ends with a commit on `feature/pocketclaw-build`. tsc/vitest don't
gate this work (no code), but `git diff --stat PRD.md` should be reviewed at
each phase end.

| Phase | Sections | Notes |
|---|---|---|
| **R0** | Move `PRD.md` → `PRD.v1.archived.md` (preserve history); create empty `PRD.md` with the §1-§16 skeleton + author / status front-matter. | Clean slate; original still in tree for cross-reference until R7. |
| **R1** | §1 Vision, §2 User Stories, §3 Goals/Non-Goals, §4 Success Metrics. | Voice-set; gets the Vivian pattern paragraph right once. |
| **R2** | §5 Competitive Analysis, §6 System Architecture (host/container/two-DB; KB; OneCLI; channels). | One ASCII diagram; one capture/curation diagram. |
| **R3** | §7 Component Specifications. | Walk the §2 inventory; one paragraph per module + path. |
| **R4** | §8 UX, §9 Security, §10 Data Flow. | Slash-commands explicitly marked `wired` / `pending kb-mcp-tool`. |
| **R5** | §11 Testing, §12 Cross-Platform, §13 Implementation Phases (revised: rearch P1-P7 + the two pending plans). | §13 is the honest project history. |
| **R6** | §14 Risks, §15 NFRs, §16 Open Items (consolidates stubbed/aspirational rows). | Open Items doubles as the project backlog. |
| **R7** | Appendices A, B, C; final read-through; delete `PRD.v1.archived.md`. | Final sanity sweep. |

Per-phase commits:
- `docs(prd): R0 archive v1, scaffold v2`
- `docs(prd): R1 vision + users + goals`
- `docs(prd): R2 architecture`
- `docs(prd): R3 component specs`
- `docs(prd): R4 ux + security + dataflow`
- `docs(prd): R5 testing + phases`
- `docs(prd): R6 risks + nfr + open items`
- `docs(prd): R7 appendices + finalize v2`

## 6. Out of scope for this plan

- The MCP `kb_*` tool itself (separate plan: `pocketclaw-kb-mcp-tool.md`).
  PRD will *describe* the tool's intent in §8 + §13 with a `(pending)` marker;
  rewriting the slash-command experience for §8 happens after that plan ships.
- Wiring `wiki-regen` and `morning-digest` crons end-to-end. PRD will list
  these as Open Items in §16 with a forward link to the kb-mcp-tool plan.
- `groups/pocketclaw/skills/*.md` rewrites (handled by the kb-mcp-tool plan).

## 7. Sign-off checklist

- [ ] User confirms section list (§1-§16) is the right shape.
- [ ] User confirms "Bryan as single user" framing (drop Sarah-Chen narrative).
- [ ] User confirms `PRD.v1.archived.md` retention policy (delete at R7).
- [ ] User confirms commit message convention (`docs(prd): R<n> ...`).
