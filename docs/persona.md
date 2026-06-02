# Persona

Clawd's personality and behaviour are defined in:

    container/sub-agent/src/persona/system_prompt_template.json

The sub-agent reads this file at startup. It is baked into the container image.
Changes require a redeploy (push -> CI -> ECS rolling update).

## File structure

The JSON has a sections object with these keys (rendered in order):

- identity: who Clawd is
- voice: tone and communication style
- formatting: WhatsApp / Telegram formatting rules
- memory: how to handle personal information
- capabilities: what Clawd can and cannot do
- knowledgeBase: how to use RAG context
- photos: how to handle inbound images
- guardrails: hard rules (never fabricate image URLs, never claim to be an LLM, etc.)
- confidence: how to handle uncertainty
- interactionStyle: follow-up questions, conversation pacing
- namingDiscipline: when to use the user's name

An examples array can hold few-shot Q&A pairs.

## System prompt assembly

_load_system_prompt() in container/sub-agent/src/llm/client.py:
1. Iterates sections in the order above
2. Appends each section as ## Heading 
 content
3. Appends _HONESTY_ADDENDUM (tool use rules, media delivery rules, format rules)
4. Appends user profile block if onboarding is complete

The assembled prompt is passed as the system field in every Bedrock Converse call.

## Tool use rules (enforced in system prompt)

CALL for: current news, live prices, weather, currency rates, user-pasted URLs.
DO NOT CALL for: stable facts, historical knowledge, definitions, math.

When generate_image returns IMAGE_URL:...:IMAGE_URL -- the entire reply must be
only that marker. No prose around it.

When generate_document returns DOC_URL:...:DOC_URL -- same rule.

## Guardrails (hard rules)

- Never pretend to be a human
- Never fabricate an image URL (do not output IMAGE_URL: with a non-S3 URL)
- Never say "I cannot" or "As an AI" -- just do it or offer an alternative
- Never pass raw Google News redirect URLs to the user

## Persona summary

Clawd is a warm, practical personal assistant. Not a technical specialist.
Not a corporate AI. Concise by default. Gets to know the user over time.
Addresses them by name occasionally once they have introduced themselves.
Ends most responses with one brief follow-up question.

## Onboarding (discovery_skill)

New users go through a 3-question onboarding flow (name, use case, reply style).
State is persisted in Redis and DynamoDB nanoclaw-user-preferences.
Once complete, the user profile is injected into every system prompt call.

## Editing the persona

1. Edit container/sub-agent/src/persona/system_prompt_template.json
2. Commit and push to feature/nanoclaw-aws-deployment
3. CI builds new image, ECS rolls out
4. Test with a fresh conversation (clear Redis cache:profile:{userId} if needed)
