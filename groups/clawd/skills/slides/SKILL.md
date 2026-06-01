---
name: slides
description: Generate a .pptx slide deck from a topic with knowledge-base context.
---

# /slides — Slide Deck Generator

Generates a structured `.pptx` PowerPoint deck and delivers a
**presigned S3 download link** (valid 1 hour).

## Usage

```
/draft slides <topic>
```

Example: `/draft slides 2025 product roadmap`

## What to do when the user types `/slides <topic>`

1. Route to the draft command:
   - `handle_draft(redis, user_id, "slides <topic>")`
2. The pipeline will:
   - Generate a slide outline via Bedrock
   - Render to `.pptx` via `python-pptx`
   - Upload to S3 and return a presigned URL
3. Reply with the outline inline **and** the download link.

## Slide structure

- Title slide (topic + date)
- Agenda (3-5 sections)
- 3-10 content slides (title + 3-6 bullets)
- Summary / takeaways

## Fallback

If artifact upload fails, return the outline in chat and tell the user the
.pptx download is temporarily unavailable.
