---
name: slides
description: Generate a PowerPoint .pptx deck from a topic, pulling context from mnemon. Use when the user types `/slides <topic>` or asks to make a presentation.
---

# /slides — Slide Deck Generator (PRD §17.5)

## When to invoke

- `/slides <topic>` — default 7 slides, minimal style
- `/slides <topic> --slides 10 --style corporate` — overrides
- `/slides <topic> --style creative` — for marketing decks

## Styles

| style | palette | use for |
|---|---|---|
| `minimal` | white bg, dark text | default; clean reads |
| `corporate` | white bg, navy headers | business / investor decks |
| `creative` | cream bg, magenta titles | marketing / pitch |

## How it works

1. Recall mnemon facts about the topic (limit 50).
2. Ask Claude to draft an outline:
   - Title slide (auto-built by module)
   - Agenda slide (3-5 sections)
   - 3-10 content slides (each: title + 3-6 bullets + speaker notes)
   - Summary / takeaways slide
3. Call `SlideGenerator.render(deck)` → .pptx file.
4. Save to `${VAULT_PATH}/presentations/YYYY-MM-DD_<topic>.pptx`.
5. Reply with file path; optionally send via Telegram document upload.

## Implementation

```ts
import { SlideGenerator, type SlideDeck } from '../../../src/modules/slide-generator.js';
const deck: SlideDeck = {
  topic, author: 'PocketClaw',
  date: new Date(),
  style: styleFromArg ?? (process.env.PPTX_STYLE as 'minimal'|'corporate'|'creative') ?? 'minimal',
  slides: slidesFromAgent, // [{ title, bullets[], notes }]
};
const result = await new SlideGenerator().render(deck);
return `Slides ready: ${result.filePath}`;
```

## Must-do

- Always include a title slide (built by module, no need to add to outline).
- Speaker notes for each content slide.
- Bullet count per slide: 3-6 (any more is unreadable).
- Save to `vault/presentations/`.

## Must-not-do

- Never embed external images without explicit user consent (privacy).
- Never use `:latest` template — versions are pinned.
- Never overwrite existing pptx with same name silently — append `_v2` if needed.
