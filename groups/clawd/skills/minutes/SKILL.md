---
name: minutes
description: Generate meeting minutes as a .docx file, delivered as a download link.
---

# /minutes — Meeting Minutes

Generates a structured .docx meeting-minutes document from calendar + email context
and delivers a **presigned S3 download link** (valid 1 hour).

## Usage

```
/draft minutes <meeting name or topic>
```

Example: `/draft minutes Q3 product review`

## What to do when the user types `/minutes <meeting>`

1. Route to the `/draft` command:
   - `handle_draft(redis, user_id, "minutes <meeting>")`
2. The pipeline will:
   - Generate the minutes body via Bedrock
   - Render it to a `.docx` via `python-docx`
   - Upload to S3 under `{userId}/drafts/`
   - Return a presigned URL
3. Reply with the inline text preview **and** the download link.

## Format

- Title + generated timestamp header
- `## Attendees` (if mentioned)
- `## Agenda`
- `## Discussion`
- `## Action Items`
- `## Decisions`

## Fallback

If the artifact upload fails (S3 unavailable), the inline markdown minutes are
still returned — tell the user the download link is unavailable but the content
is in chat.
