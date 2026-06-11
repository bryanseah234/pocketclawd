---
name: research
description: Generate a research report from local knowledge-base facts — strict no-web-search privacy invariant. Delivers .docx download link.
---

# /research — Local Research Report

Synthesises a structured report from the local knowledge base and delivers a
**presigned .docx download link** (valid 1 hour).

## Usage

```
/draft research <topic>
```

Example: `/draft research competitor pricing Q4`

## Privacy invariant

**NO web search. NO external APIs.** Only local sources via `kb_recall`.
If fewer than 3 sources are found, refuse and suggest `/ingest` first.

## What to do when the user types `/research <topic>`

1. Route to the draft command:
   - `handle_draft(redis, user_id, "research <topic>")`
2. The pipeline will:
   - Generate the report body via Bedrock (no web search in the prompt)
   - Render to `.docx`
   - Upload and return a presigned URL
3. Reply with inline summary + download link.

## Report structure

- 2-3 paragraph executive summary with `[N]` citations
- 5-10 key findings with citations
- Timeline of events
- Related entities
- Source list at the end

## Must-not-do

- NEVER call web search (Tavily, Exa, Perplexity, Google, etc.)
- Never invent facts not in the recall result
