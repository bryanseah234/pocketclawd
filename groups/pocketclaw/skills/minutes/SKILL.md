---
name: minutes
description: Generate meeting minutes from a calendar event + email threads, save as .docx to the Obsidian vault. Use when the user types `/minutes <meeting-name>` or asks to capture a meeting.
---

# /minutes — Meeting Minutes Generator (PRD §17.3)

## When to invoke

- User types: `/minutes <meeting-name>` or `/minutes <name> --date 2026-05-22`
- After a calendar event ends (auto-trigger via cron, if email threads exist)

## How it works

1. Recall context for the meeting from mnemon (calendar + email + contact facts).
2. Ask Claude to synthesize: agenda, key discussion points, action items, decisions.
3. Render to `.docx` via `MeetingMinutesGenerator.generate(ctx)`.
4. Save to `${VAULT_PATH}/meetings/YYYY-MM-DD_<title>.docx`.
5. Reply with file path; optionally attach the .docx to Telegram.

## Implementation

```ts
import { MeetingMinutesGenerator } from '../../../src/modules/meeting-minutes.js';
const gen = new MeetingMinutesGenerator();
const draft = await gen.draftFromMnemon(meetingTitle, eventDate);
// ... agent fills in agenda / actions / decisions from mnemon recall
const result = await gen.generate({
  ...draft,
  agenda: agendaFromAgent,
  actions: actionsFromAgent,
  decisions: decisionsFromAgent,
});
return `Minutes saved to ${result.filePath} (${result.bytes} bytes)`;
```

## Must-do

- Pull all context from mnemon ONLY — no external APIs.
- Save to vault, never to /tmp.
- Reply with vault-relative path, not absolute (privacy in chat history).

## Must-not-do

- Don't include raw email bodies in chat — only synthesized highlights.
- Don't overwrite existing minutes file without `--force` flag from user.
