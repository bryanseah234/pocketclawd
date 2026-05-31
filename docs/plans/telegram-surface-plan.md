# Plan - Add Telegram as a Second Messaging Surface (cloud Clawd)

> STATUS: PLAN ONLY - not implemented. Decisions needed from Bryan before any code.
> Goal: Telegram with the SAME feature set as WhatsApp (chat, photos, documents,
> memory, onboarding, digest), sharing the same per-user data/memory.

## The core problem

There IS a Telegram adapter in the repo's `channels` branch (`/add-telegram` skill ->
`src/channels/telegram.ts` + Chat SDK bridge). BUT that adapter targets the NanoClaw
v2 LOCAL-HOST harness (per-session Docker containers, two-DB split, `src/channels/`
registry). The CLOUD Clawd does NOT use that path at all. Cloud flow is:

    WhatsApp (Baileys) -> orchestrator (EC2) -> DynamoDB + Redis queue -> sub-agent (ECS) -> Bedrock

So "add Telegram" on cloud is NOT a skill install. It means building a Telegram ingress
that feeds the SAME orchestrator pipeline WhatsApp uses. Good news: everything DOWNSTREAM
of the channel (routing, data gateway, RAG, persona, sub-agent, digest) is already
channel-agnostic - it keys off a `user_id`. We only need a new ingress + identity mapping.

## Architecture decision: how Telegram messages get in

### Option A - Telegram Bot inside the orchestrator (RECOMMENDED)
Add a `TelegramChannel` module in the orchestrator (mirrors the WhatsApp/Baileys module)
using the Bot API (grammy or node-telegram-bot-api). It receives updates, normalizes them
to the same internal InboundMessage shape WhatsApp produces, hands off to the SAME router.
Outbound replies go back via bot.sendMessage.
- Pro: minimal new infra; reuses 100% of downstream pipeline; one process.
- Con: orchestrator gains a second poller (fine - r6i.4xlarge has headroom).
- Use getUpdates LONG-POLL initially (no public HTTPS path needed; 443 reserved for Caddy).

### Option B - Separate Telegram microservice -> Redis queue
Small Fargate/EC2 service owning the bot, pushing normalized messages onto
`queue:agent:dispatch`.
- Pro: isolation. Con: new deploy unit + task def + ops surface. Overkill for one bot.

RECOMMENDATION: Option A.

## Identity & session model (the part that needs real planning)

WhatsApp keys users by E.164 phone (`user_id = +6584731565`). Telegram has no phone -
it has numeric chat.id / from.id. Decisions:

### D1 - user_id namespace
DynamoDB tables partition on `userId`. Must NOT collide TG and WA IDs.
- (a) Prefix both: `wa:+6584731565`, `tg:123456789`. Clean but needs migration of existing WA rows.
- (b) Keep WhatsApp bare, prefix only Telegram (`tg:123456789`). No migration. RECOMMENDED (lowest risk).

### D2 - cross-surface memory linking (THE BIG DECISION)
Old local CLAUDE.local.md promised "shared memory across both". To make a user's WhatsApp
history and Telegram history resolve to the SAME memory/KB, we need an identity link table
`nanoclaw-user-links` mapping surface_id -> canonical_user_id, plus a `/link <code>` UX.
- If you DON'T need cross-surface memory: skip entirely, each surface is its own user. Simpler.
- DECISION NEEDED.

### D3 - onboarding
Discovery-question onboarding is stored in nanoclaw-user-preferences keyed by user_id.
Runs automatically on first contact on any surface once D1 is set. Free for Telegram.

## Feature parity checklist (mostly free - downstream is shared)

| Feature | Shared? | Telegram-specific work |
|---|---|---|
| Text chat + Bedrock + history | yes | normalize update -> InboundMessage |
| Photo handling (vision -> KB) | yes | download via getFile, feed photo-processor |
| Document upload + RAG ingest | yes | handle message.document, fetch file |
| Memory / KB recall | yes | none (keyed by user_id) |
| Onboarding | yes | none |
| Confidence tiers / guardrails | yes (persona) | none |
| Morning digest (07:00) | delivery only | add TG delivery branch (digest skill is NOT YET WIRED for TG today) |
| Formatting | NO | TG uses MarkdownV2/HTML not *bold*. Port telegram-markdown-sanitize.ts from channels branch |

## Storage / DB plan (concrete)
1. No new chat/pref tables - reuse nanoclaw-chat-messages + nanoclaw-user-preferences with `tg:` user_id (D1b).
2. Optional nanoclaw-user-links table ONLY if D2 = share memory.
3. Secrets: add TELEGRAM_BOT_TOKEN to nanoclaw/app-config (NOT env). Orchestrator reads at boot.
4. Session/pairing: TG bots are stateless (just a token). No QR, no S3 session. Drop all pairing machinery.

## Rollout plan (phased, gated behind TELEGRAM_ENABLED=false)
- T1: Orchestrator TelegramChannel (long-poll), token from Secrets Manager, normalize->router, text round-trip.
- T2: Photo + document handlers wired to existing processors.
- T3: Telegram MarkdownV2 formatter (port from channels branch).
- T4: Digest delivery branch for Telegram; flip digest skill from NOT YET WIRED to wired.
- T5: (Optional) cross-surface identity linking (D2).
Each phase: commit, CI green, deploy behind flag; flip TELEGRAM_ENABLED=true only after T1-T3 verified on a test bot.

## Open decisions for Bryan
1. Ingress: Option A (in-orchestrator long-poll)? 
2. user_id scheme: D1b (tg: prefix, no WA migration)?
3. Cross-surface memory: WA + TG share ONE brain (link table + /link UX), or independent users? <- the big one
4. Long-poll now, or wait for Caddy/HTTPS to do webhooks?
