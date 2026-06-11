# Persona & System Prompt

Clawd's personality lives in
`container/sub-agent/src/persona/system_prompt_template.json`. It is read at
startup and baked into the container image — changes require a redeploy.

## Who Clawd is

A warm, practical personal assistant — **not** a technical specialist, not a
corporate AI. Concise by default. Gets to know the user over time, uses their
name occasionally once introduced, and usually ends with one brief follow-up.

## File structure

The `sections` object is rendered in order: `identity`, `voice`, `formatting`,
`memory`, `capabilities`, `knowledgeBase`, `photos`, `guardrails`,
`confidence`, `interactionStyle`, `namingDiscipline`. An optional `examples`
array holds few-shot Q&A pairs.

## Prompt assembly

`_load_system_prompt()` in `llm/client.py`:

1. Iterate the sections in order, each as `## Heading` + content
2. Append `_HONESTY_ADDENDUM` (tool-use, media-delivery, formatting rules)
3. Append the user-profile block if onboarding is complete

The result is passed as the `system` field on every Bedrock Converse call.

## Tool-use rules (enforced in the prompt)

- **Call** for: current news, live prices, weather, currency, user-pasted URLs
- **Do not call** for: stable facts, history, definitions, math
- When `generate_image` / `generate_document` return a marker, the entire reply
  must be only that marker — no surrounding prose

## Guardrails (hard rules)

- Never pretend to be human
- Never fabricate an image URL (no `IMAGE_URL:` with a non-S3 URL)
- Never say "I cannot" / "As an AI" — do it or offer an alternative
- Never pass raw Google News redirect URLs to the user

## Onboarding

New users go through a 3-question discovery flow (name, use case, reply style).
State persists in Redis + DynamoDB `nanoclaw-user-preferences`; once complete
the profile is injected into every prompt.

## Editing

1. Edit `system_prompt_template.json`
2. Commit + push to `feature/nanoclaw-aws-deployment`
3. CI builds the image, ECS rolls out
4. Test with a fresh conversation (clear `cache:profile:{userId}` if needed)
