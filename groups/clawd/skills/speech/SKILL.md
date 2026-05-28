---
name: speech
description: Draft a speech with calibrated word count, tone, and structure. Use when the user types `/speech <topic> [--duration Xm] [--tone formal|casual|persuasive]`.
---

# /speech — Speech Draft Generator (PRD §17.6)

## When to invoke

- `/speech <topic>` — default 5 minutes, formal tone
- `/speech <topic> --duration 10m --tone persuasive`
- `/speech <topic> --tone casual` — wedding toast, light keynote

## Word-count calibration

| Duration | Words target | Use for |
|---|---|---|
| 1m | ~150 | Lightning intro |
| 5m | ~750 | Standard talk |
| 10m | ~1500 | Conference talk |
| 15m | ~2250 | Keynote |
| 20m+ | ~3000+ | Long-form lecture |

## Tone rubric

- **formal**: precise vocabulary, full sentences, no contractions, citations OK
- **casual**: contractions, anecdotes, shorter sentences, occasional rhetorical questions
- **persuasive**: tricolons, repetition, call-to-action close, emotional hooks

## Structure (apply regardless of tone)

1. **Hook** (10-15% of words): question, statistic, story, or paradox
2. **Roadmap** (5-10%): "Today we'll cover three things..."
3. **Main points** (60-65%): 3 sections with transitions
4. **Story / evidence** (10-15%): one anchor anecdote
5. **Close** (5-10%): callback to hook + CTA

## How it works

This skill is **module-free** — it's pure agent prompting. The agent:

1. Recalls mnemon facts on `<topic>` for source material.
2. Builds outline matching the structure above.
3. Drafts speech to target word count (compute words = duration × 150).
4. Counts words, trims/expands to land within ±5% of target.
5. Writes Markdown to `${VAULT_PATH}/speeches/YYYY-MM-DD_<topic>.md` with frontmatter:
   ```yaml
   ---
   title: <topic>
   duration: <Xm>
   tone: <formal|casual|persuasive>
   word_count: <actual>
   target_words: <target>
   created: <ISO date>
   ---
   ```
6. Reply with file path + first paragraph preview.

## Must-do

- Hit the target word count within ±5%.
- Include a delivery tip in frontmatter (`pace_wpm: 150`, `pause_after_hook: true`).
- Save to `vault/speeches/`, Markdown format.

## Must-not-do

- Don't add disclaimers like "this is AI-generated" inside the speech body.
- Don't include speaker stage directions in the body — those go in frontmatter.
