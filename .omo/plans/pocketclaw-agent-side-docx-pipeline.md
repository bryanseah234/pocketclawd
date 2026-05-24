# PocketClaw Agent-side Document Pipeline

**Status:** STUB — awaiting prioritization
**Replaces:** N/A (this is new wiring, not a re-wire)
**Forward-linked from:** `groups/pocketclaw/skills/minutes/SKILL.md`, `.../research/SKILL.md`, `.../slides/SKILL.md`

## Why parked

Three skills (`/minutes`, `/research`, `/slides`) are in the *aspirational* tier today. The synthesis step works inline — the agent can `kb_recall` topic-relevant facts and produce structured prose in chat. What's missing is **artefact production**: writing a `.docx` / `.pdf` / `.pptx` file to the vault.

The container intentionally doesn't ship `docx`, `puppeteer`/`pdfkit`, or `pptxgenjs`. Those libraries are heavy and would inflate every agent-runner image. Better pattern: the container *describes* the document via a structured payload, and the host renders to disk.

## Proposed wire-up

Add a generic `doc_write` system action to the M0 transport pattern.

### Container side

New MCP tool family in `container/agent-runner/src/mcp-tools/doc.ts`:

- `doc_write_minutes(meta, agenda[], actions[], decisions[]) -> { filePath, bytes }`
- `doc_write_research(topic, summary, findings[], timeline[], sources[]) -> { filePath, bytes }`
- `doc_write_slides(topic, style, slides[{ title, bullets[], notes }]) -> { filePath, bytes }`

Each tool writes a `kind='system'` row to `outbound.db` with:

```ts
{
  action: 'doc_request',
  request_id,
  doc_type: 'minutes' | 'research' | 'slides',
  payload: { /* full structured doc */ },
}
```

Container sidecar polls `inbound.db` for `doc_response` matching `request_id`, returns the result up to the agent.

### Host side

New `src/modules/document-actions.ts`, parallel to `kb-actions.ts`:

- `handleDocRequest(row)` switches on `doc_type` and calls one of:
  - `MeetingMinutesGenerator.generate(payload)` → `${VAULT_PATH}/meetings/YYYY-MM-DD_<title>.docx`
  - `ResearchReportGenerator.render(payload)` → `${VAULT_PATH}/research/YYYY-MM-DD_<topic>.pdf`
  - `SlideGenerator.render(payload)` → `${VAULT_PATH}/presentations/YYYY-MM-DD_<topic>.pptx`
- Permission gate (pocketclaw-only, same as `kb_*`).
- Writes `doc_response` with `{ ok, result: { filePath, bytes } | error }`.

Wire into `delivery.ts` polling loop alongside `handleKbRequest`.

### Skills

Once shipped, rewrite the three deferred skills to call the new tools instead of synthesizing-only:

- `/minutes` → `kb_recall(meeting)` then `doc_write_minutes(...)` then reply with file path.
- `/research` → `kb_recall(topic, k=20)`, refuse if `< 3 sources`, then `doc_write_research(...)`.
- `/slides` → `kb_recall(topic, k=20)` then `doc_write_slides(...)`.

Each skill keeps the inline-only fallback as the "if doc_write_* errors, here's the content as text" path.

## Dependencies

- Knowledge base + M0 transport (done).
- The three host-side generator modules (`meeting-minutes.ts`, `research-report.ts`, `slide-generator.ts`) — already in `src/modules/`. Verify they still build against current types and aren't relying on Bedrock or mnemon. Likely a small fix-up pass.

## Files that change

- New: `container/agent-runner/src/mcp-tools/doc.ts` (+ `doc.test.ts`, + `doc.instructions.md`).
- New: `src/modules/document-actions.ts` (+ `document-actions.test.ts`).
- Edit: `src/delivery.ts` — register `handleDocRequest` alongside `handleKbRequest`.
- Edit: the three SKILL.md files (`minutes`, `research`, `slides`) — remove NOT YET WIRED banner, document the new tool calls.
- Edit: root `CLAUDE.md` — add "Document MCP tools (in-container)" subsection mirroring the kb_* one.

## Acceptance

- All three host generators build clean with current `KnowledgeBase` types (no mnemon refs).
- Container `bun test mcp-tools/doc.test.ts` passes (5+ tests covering happy paths, permission gate, stale-row correlation).
- Host `vitest run document-actions.test.ts` passes (5+ tests).
- Manual smoke: `/minutes Test Meeting` in Telegram → file at `vault/meetings/<today>_Test Meeting.docx`, opens cleanly in Word/LibreOffice.

## Out of scope

- Sending the artefact back to Telegram as a document upload. v0 just writes to disk; the user opens the vault. Sending-as-attachment is a follow-on pass.
- Templates / themes beyond what the three generators already accept.
- Co-authored / multi-turn document sessions. v0 is one-shot.
