# Clawd — Product Context

## What it is

Clawd is a WhatsApp-native AI assistant for busy professionals in Singapore and Southeast Asia. It acts as a personal chief of staff — remembers what you tell it, summarises documents you send it, retrieves context across thousands of messages, generates briefings, drafts artefacts. No app to download. No new interface. Just WhatsApp.

The deployed surface runs on AWS in Singapore (`ap-southeast-1`) for PDPA-compliant data residency.

## Audience

**Primary** — working professionals 25–45, Singapore / Southeast Asia, mobile-first, time-poor. Already live in WhatsApp daily. Not early adopters. They distrust complexity and want something that works invisibly. They want a brilliant colleague who responds in seconds, not a chatbot that announces itself as an AI.

**Secondary** — admins (Bryan + future operators) running the platform. Technical, manage the dashboard at `/admin` to monitor health, link WhatsApp, inspect users, configure the persona.

## Promise

> *The AI assistant that actually gets to know you.*

It remembers. It surfaces what you forgot. It drafts the thing you didn't have time to write. It speaks plainly. It never wastes your time with "As an AI…" preambles or invented facts.

## Brand voice

Warm, calm, capable. Like a brilliant assistant who's also a good friend — never stuffy, never breathless. Plain English. No jargon. No "unleash the power of AI." Honest about what it knows and doesn't know.

The persona is defined in `container/sub-agent/src/persona/system_prompt_template.json` (11 sections: identity, voice, formatting, memory, capabilities, knowledgeBase, photos, guardrails, confidence, interactionStyle, namingDiscipline — plus annotated examples). Clawd is a warm personal life assistant, not a technical specialist. Changes take effect on the next container deploy.

## Visual identity

Premium stationery aesthetic. Physical, tactile, analogue-warm digital — the opposite of cold SaaS minimalism.

| Token | Value | Where |
|---|---|---|
| Background | `#F5F0E8` oatmeal parchment | Pages |
| Surface | `#FDFAF4` warm cream | Cards |
| Text | `#3D2B1F` deep espresso | Body |
| Accent | `#C9973A` mustard gold | Interactive |
| Headings | Playfair Display | Editorial serif |
| Body | Inter | Clean sans |
| Cards | `rgba(255,255,255,0.7)` | Frosted on oatmeal |
| Shadow | `rgba(61,43,31,0.08)` | Warm, never cold black |

Both surfaces — the landing page and the admin dashboard — use the same system. See `DESIGN.md` for full tokens and `src/static/landing.html` / `src/static/admin.html` for the implementations.

## Distribution surfaces

| Surface | Audience | URL / channel |
|---|---|---|
| Landing page | Public | http://3.0.132.150:3000/ |
| Admin dashboard | Operators | http://3.0.132.150:3000/admin |
| WhatsApp | End users | +65 8473 1565 (current pairing) |
| Telegram | End users | via `/add-telegram` skill |

## What we are not

We are not a B2B SaaS dashboard with 47 toggles. We are not a chatbot wrapper around the OpenAI API. We are not a productivity app you have to remember to open. We do not summarise the open internet — we summarise *your* world: documents, photos, conversations, and ingested cloud sources you've explicitly given us.
