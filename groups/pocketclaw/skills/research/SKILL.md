---
name: research
description: Generate a research report from local knowledge-base facts only — strict no-web-search privacy invariant (NOT YET WIRED for PDF export).
---

# /research — Local Research Report

## Status

**Synthesis works inline; PDF export not yet wired.** The privacy invariant — only local sources, never the open web — still holds; the in-container agent can do the synthesis end-to-end via `kb_recall`. What it can't do is render the result to a PDF artefact in the vault. That requires the same host-side file-export pipeline as `/minutes`.

## Privacy invariant

**NO web search. NO external APIs.** Only sources:
- The knowledge base (every fact ever ingested) — accessed via `kb_recall`
- Watch-path index (files indexed by the host-side file-watcher; surfaced into the KB on ingest)

If the agent doesn't have enough local data, it should say so and stop — NOT fall back to web search.

## What to do when the user types `/research <topic>`

1. Call `kb_recall(query=<topic>, k=20)` to gather sources.
2. If `insights.length < 3`, reply: `Not enough local data on "<topic>" — only N sources. Try ingesting more first via /ingest.` and stop.
3. Group sources by their `source` tag (gmail, github, contacts, etc.).
4. Synthesize a report in chat:
   - 2-3 paragraph executive summary, citing `[N]` referring to source indices
   - 5-10 key findings with citations
   - Timeline of events (chronological, where dates are present)
   - Related entities (people / orgs / projects mentioned in the recall)
5. List the sources at the end with `[N] <text excerpt> — source=<s>`.
6. Tell the user the PDF export is parked; the chat reply IS the report for now.

## Must-do

- Cite every claim with `[N]` referencing the sources list.
- If source count < 3, refuse and suggest `/ingest`.

## Must-not-do

- **NEVER call web search** (Tavily, Exa, Perplexity, Google, etc).
- Never invent facts not in the recall result.
- Never include raw API tokens or session IDs in the output.

## Forward link

PDF export tracked in: the follow-on `.omo/plans/pocketclaw-agent-side-docx-pipeline.md` (shared with `/minutes` and `/slides`).
