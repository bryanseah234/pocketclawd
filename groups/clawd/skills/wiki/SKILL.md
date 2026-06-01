---
name: wiki
description: Summarise what Clawd knows about a topic from the knowledge base.
---

# /wiki — knowledge base summary

Produces a structured summary of everything Clawd knows about a topic,
drawn from the local knowledge base via `kb_recall`.

## What to do when the user types `/wiki <topic>`

1. Call `kb_recall(query=<topic>, k=15)` to gather sources.
2. If fewer than 3 sources found: reply "Not enough in my knowledge base on
   \"<topic>\" yet — try ingesting more via /ingest." and stop.
3. Synthesise a wiki-style summary in chat:
   - **Overview** (1-2 paragraphs from the strongest sources)
   - **Key facts** (bulleted, each cited with the source)
   - **People / orgs mentioned** (if any appear in the recall)
   - **Timeline** (if dates are present)
4. End with "Sources: N items from [source types]."

## Must-not-do

- Do not write to any file or path — there is no mounted vault in cloud mode.
- Do not call web search.
- Never invent facts not in the recall result.
