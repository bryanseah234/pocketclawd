# Plan - Reconcile Clawd Persona (generalist, not technical specialist)

> STATUS: DONE. Finding resolved: sub-agent reads persona from JSON file in container image
> (`src/persona/system_prompt_template.json`), NOT Secrets Manager. `docs/CLAWD.md` rewritten
> to match the correct generalist persona.

## THE KEY FINDING (this is bigger than a doc fix)

There are THREE persona artifacts. They disagree, and the WRONG one is live:

| Artifact | Persona it describes | Is it live? |
|---|---|---|
| container/sub-agent/src/persona/system_prompt_template.json | CORRECT: "warm, sharp personal assistant... NOT a coding assistant... second brain"; 13 sections (identity, voice, formatting, memory, capabilities, knowledgeBase, photos, guardrails, confidence, interactionStyle, namingDiscipline, examples); useCase=personal-life-assistant; v2.0.0 | NO - sitting in repo, unused |
| nanoclaw/app-config:systemPromptTemplate (AWS Secrets Manager) | WRONG: "senior technical specialist... deep expertise across software engineering, cloud infrastructure, data systems, frontend"; 7 sections (identity, onboarding, responseStyle, guardrails, confidence, coding, escalation) | YES - THIS IS WHAT PRODUCTION SERVES |
| docs/CLAWD.md | Documents the WRONG (technical) persona accurately | doc only |

CONSEQUENCE: Right now, real WhatsApp users get a TECHNICAL-SPECIALIST Clawd (talks about
runtime versions, fenced code blocks, frontend/infra/data onboarding). NOT the warm
personal-life assistant in the JSON. The repo JSON was written (v2.0.0, 2026-05-28) but
NEVER pushed to the live secret. docs/CLAWD.md is not "stale" - it faithfully documents
the wrong live value.

## What "correct" looks like (the JSON, verbatim intent)
- Identity: "warm, sharp personal AI assistant living inside the user's WhatsApp... a
  trusted friend... NOT a customer-service bot, NOT a coding assistant, NOT a chatbot."
- Helps with: errands, to-dos, photos, calendar thinking, brain-dumps, journaling,
  drafting messages, lookups, summarizing docs, trip/meal planning, finding things in
  notes - "the second brain they wish they had."
- Voice: conversational, Singlish-friendly, match the user's energy, answer-first.
- Formatting: WhatsApp-native (*bold*, _italic_, no markdown headers, <=1 emoji).
- Has examples (yo -> "yo. what's up?"), naming discipline, photo protocol, etc.

## What still makes sense to KEEP from the current live persona
You said these still make sense - and they do, they just need to be re-homed onto the
generalist identity:
- escalation - keep (compliance-sensitive topics -> recommend a professional). Already
  present in JSON guardrails ("medical/legal/financial -> recommend a real professional").
- confidence tiers - keep. JSON has HIGH/PARTIAL/LOW (=NONE) already.
- guardrails - keep. JSON guardrails are RICHER (anti-injection, naming, no-AI-disclosure).
- onboarding - keep the CONCEPT but de-technical it. The live "frontend/infra/data?"
  onboarding is wrong for a life assistant. JSON has no explicit onboarding section -
  DECISION: do we want a generalist onboarding (e.g. "what should I call you? what do you
  want help with most - reminders, notes, planning?") or none?
- responseStyle - keep; JSON folds this into voice + formatting + interactionStyle.
- coding section - REMOVE. A personal-life assistant does not need a coding-output spec.

## Recommended action (TWO parts)

### Part 1 - DOC FIX (safe, no prod impact) - I can do now on your OK
Rewrite docs/CLAWD.md to document the CORRECT generalist persona: replace the identity
blockquote, replace the technical onboarding, drop the `coding` section, list the JSON's
13 sections instead of the 7 technical ones. Keep the hot-swap instructions (still valid).

### Part 2 - LIVE SECRET FIX (PROD CHANGE - needs explicit go)
Push the correct system_prompt_template.json into nanoclaw/app-config:systemPromptTemplate
so production actually serves the generalist Clawd. Procedure (reversible):
  1. Back up current secret value to a local file (so we can roll back).
  2. Read current secret JSON, replace the systemPromptTemplate key with the repo JSON's
     `sections` object (matching the shape the orchestrator expects - VERIFY the loader
     reads `.sections.*` vs flat keys first).
  3. put-secret-value.
  4. Orchestrator picks up within 5 min (cache TTL) or restart for instant.
  5. Send a test WhatsApp message, confirm Clawd answers in the warm/generalist voice.
GATING QUESTION: the live secret uses FLAT sections (identity, onboarding,... at top of
systemPromptTemplate), while the repo JSON nests under `sections:` and has different keys
(voice, formatting, memory, capabilities, examples...). Before pushing I must confirm the
orchestrator's persona LOADER expects which shape - otherwise new sections silently drop.
This needs a code read of where systemPromptTemplate is consumed (likely
src/cloud or container/sub-agent persona loader).

## Open decisions for Bryan
1. Confirm: production SHOULD serve the generalist persona (the JSON), correct? (You said yes.)
2. Do Part 1 (doc rewrite) now? (safe)
3. Do Part 2 (live secret swap) - and when? It changes how Clawd talks to real users
   immediately. I will NOT touch the live secret without your explicit go.
4. Onboarding: keep a de-technicalised generalist onboarding, or drop onboarding entirely?
5. Should I also align the loader/code so the repo JSON is the single source of truth that
   gets DEPLOYED to the secret (so this never drifts again)?
