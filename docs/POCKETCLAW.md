# PocketClaw — Architecture (PocketClaw layer)

This doc describes the **PocketClaw-specific** layer added on top of NanoClaw v2. For the underlying NanoClaw architecture (host/container split, two-DB model, channel adapter registry) see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Where PocketClaw lives

| Path | Owner | Purpose |
|------|-------|---------|
| `groups/pocketclaw/CLAUDE.md` | PocketClaw | Agent identity + behavioural directives |
| `groups/pocketclaw/skills/` | PocketClaw | 9 slash commands (memory, recall, wiki, ingest, status, digest, audit, auth, photo) |
| `src/modules/debouncer.ts` | PocketClaw | 5s unified message batch queue |
| `src/modules/photo-processor.ts` | PocketClaw | Vision pipeline: validate → resize → describe → store → delete |
| `src/modules/ingestion/` | PocketClaw | Google / Microsoft / Apple cloud ingesters + scheduler + file watcher |
| `src/modules/wiki-generator.ts` | PocketClaw | Karpathy-style LLM wiki for Obsidian |
| `src/modules/pocketclaw.ts` | PocketClaw | Cron driver — self-registers at import |
| `src/channels/telegram.ts` | NanoClaw skill (`/add-telegram`) | Telegram Chat SDK adapter |
| `src/channels/whatsapp.ts` | NanoClaw skill (`/add-whatsapp`) | Baileys adapter |
| `.claude/skills/add-mnemon/` | NanoClaw skill (`/add-mnemon`) | mnemon installer |
| `.claude/skills/add-karpathy-llm-wiki/` | NanoClaw skill | wiki support |

## Component diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                         MESSAGING INTERFACES                          │
│  [Telegram Bot API]  ──────────────────────┐                         │
│  (long polling — outbound only)           │                         │
│                                            ▼                         │
│  [WhatsApp / Baileys] ─────────────► [MessageDebouncer]              │
│  (persistent named volume)            5-second batch window           │
│                                       sticker drop (silent)          │
└────────────────────────────────────────────┬─────────────────────────┘
                                             │
                                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    NANOCLAW HOST (Node + pnpm)                        │
│   src/router.ts → session-manager.ts → inbound.db                    │
│   src/delivery.ts ← outbound.db ← container/agent-runner             │
│   src/modules/pocketclaw.ts → cron driver (02:00 / 03:00 / 07:00)    │
└────────────────────────────────────────────┬─────────────────────────┘
                                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│              AGENT CONTAINER (Docker / Bun + Claude Code)             │
│   groups/pocketclaw/CLAUDE.md → identity + directives                │
│   groups/pocketclaw/skills/   → /memory /recall /wiki ...            │
│   Claude Code orchestrates:                                          │
│     - mnemon recall before answering                                 │
│     - mnemon remember for new facts                                  │
│     - photo-processor for inbound images                             │
│     - wiki-generator for /wiki                                       │
│     - cloud scheduler for /ingest                                    │
└────────────────────────────────────────────┬─────────────────────────┘
                                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      LOCAL SERVICES (Host)                            │
│  Ollama :11434                ~/.pocketclaw/mnemon.db                │
│  - nomic-embed-text           (single SQLite — shared across         │
│  - llava (vision)              Telegram + WhatsApp)                  │
│                                                                      │
│  ~/.pocketclaw/vault/  ◄────────────────────  Syncthing  ◄──── peers │
│  ~/.pocketclaw/watch/  → file-watcher.ts (read-only mount)           │
│  ~/.pocketclaw/logs/audit.log                                        │
└──────────────────────────────────────────────────────────────────────┘
                │
                │  (only assembled prompts leave the machine)
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│          ANTHROPIC API (only outbound third-party traffic)            │
└──────────────────────────────────────────────────────────────────────┘
```

## Cron jobs (PRD §10)

Driven by `src/modules/pocketclaw.ts`. Runs every minute, fires when a job's scheduled time falls within the most recent minute window:

| Time (local) | Job | Effect |
|---|---|---|
| 02:00 | `CloudScheduler.runAll()` | Pulls last 24h from Gmail / Outlook / iCloud → mnemon |
| 03:00 | `WikiGenerator.generateAll()` | Regenerates every entity's `vault/wiki/<entity>.md` |
| 07:00 | morning digest | Composes summary, sends via Telegram (primary channel) |

Audit log line emitted per run: `<ISO> | CRON | <job> START/END/FAIL | <details>`.

## Privacy boundary

Only the **assembled prompt** sent by Claude Code to `api.anthropic.com` ever leaves the machine. Everything else — emails, photos, contacts, files — is processed locally and stored in `~/.pocketclaw/mnemon.db`. The audit log records every tool call so you can verify this.

## Threat model

| Threat | Mitigation |
|--------|------------|
| Open inbound ports | None — Telegram + WhatsApp are outbound-only (long polling / WebSocket) |
| Prompt injection via email | `stripHtml()` + per-fact mnemon insertion |
| WhatsApp session theft | named volume `wa-session/`, gitignored |
| Photo privacy leak | Cache deleted post-processing; only descriptions stored |
| Sticker spam DoS | Silent drop at debouncer entry — zero processing cost |

See [PRD.md §9](../PRD.md) for the full security model.
