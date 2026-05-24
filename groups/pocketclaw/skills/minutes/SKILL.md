---
name: minutes
description: Generate meeting minutes .docx from calendar + email context (NOT YET WIRED).
---

# /minutes — Meeting Minutes Generator

## Status

**Not yet wired.** Generating .docx from the in-container agent requires either:

- Shipping a `.docx` writer (e.g. `docx` npm pkg) inside the container and exposing a `kb_write_docx(meta, blocks, path)` MCP tool, **or**
- Adding a host-side handler that the agent triggers with a `system` action (similar to `kb_request`) carrying the structured minutes payload, and the host renders + saves the file.

Both are real design work — large-binary file delivery has its own concerns (streaming, vault path resolution, attachment back to chat). Out of scope for the kb_* tool family.

## What to do when the user types `/minutes <meeting>`

1. Recall context from the knowledge base:
   - `kb_recall(query="<meeting title>", k=10)` — surfaces calendar fact + email threads + contact mentions
2. Synthesize the minutes inline in chat: agenda, key discussion points, action items, decisions.
3. Reply with the synthesized minutes as a regular chat message.
4. Tell the user the .docx export is parked and you've replied with the content for now — they can paste it into a doc themselves.

This delivers the *content* of the skill (a structured meeting summary from local data) without the artefact (the .docx file). When the docx pipeline ships, this skill will be rewritten to emit a file path.

## Forward link

Tracked in: the follow-on `.omo/plans/pocketclaw-agent-side-docx-pipeline.md` (to be written). Same pipeline will unblock `/research` (PDF) and `/slides` (.pptx).
