---
name: slides
description: Generate a .pptx deck from a topic with knowledge-base context (NOT YET WIRED).
---

# /slides — Slide Deck Generator

## Status

**Not yet wired.** Same blocker as `/minutes` and `/research` — large-binary file generation (.pptx) needs a host-side rendering pipeline triggered by a `system` action. The in-container agent doesn't ship pptxgenjs and shouldn't.

## What to do when the user types `/slides <topic>`

1. Call `kb_recall(query=<topic>, k=20)` to gather context.
2. Synthesize the deck outline inline in chat:
   - Title slide
   - Agenda (3-5 sections)
   - 3-10 content slides (each: title + 3-6 bullets + speaker notes)
   - Summary / takeaways
3. Format the outline cleanly (Markdown headings + nested bullets).
4. Tell the user the .pptx export is parked and you've replied with the outline for now.

## Forward link

Tracked in: the follow-on `.omo/plans/pocketclaw-agent-side-docx-pipeline.md` (shared with `/minutes` and `/research`).
