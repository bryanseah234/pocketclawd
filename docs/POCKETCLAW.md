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
│     - kb.recall before answering                                    │
│     - kb.remember for new facts                                      │
│     - photo-processor for inbound images                             │
│     - wiki-generator for /wiki                                       │
│     - cloud scheduler for /ingest                                    │
└────────────────────────────────────────────┬─────────────────────────┘
                                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      LOCAL SERVICES (Host)                            │
│  Ollama :11434                Postgres :5432 (pgvector)              │
│  - nomic-embed-text           - knowledge table (vector(768))        │
│  - llava (vision)             - shared across Telegram + WhatsApp    │
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
| 02:00 | `CloudScheduler.runAll()` | Pulls last 24h from Gmail / Outlook / iCloud → knowledge base (pgvector) |
| 03:00 | `WikiGenerator.generateAll()` | Regenerates every entity's `vault/wiki/<entity>.md` (currently `SKIP \| no-provider` until re-wired through the agent container) |
| 07:00 | morning digest | Composes summary, sends via Telegram (currently `SKIP \| no-handler` until re-wired through the agent container) |

Audit log line emitted per run: `<ISO> | CRON | <job> START/END/FAIL | <details>`.

## Privacy boundary

Only the **assembled prompt** sent by Claude Code to `api.anthropic.com` ever leaves the machine. Everything else — emails, photos, contacts, files — is processed locally and stored in the local Postgres knowledge base (`127.0.0.1:5432`). The audit log records every tool call so you can verify this.

## Threat model

| Threat | Mitigation |
|--------|------------|
| Open inbound ports | None — Telegram + WhatsApp are outbound-only (long polling / WebSocket) |
| Prompt injection via email | `stripHtml()` + per-fact knowledge-base insertion |
| WhatsApp session theft | named volume `wa-session/`, gitignored |
| Photo privacy leak | Cache deleted post-processing; only descriptions stored |
| Sticker spam DoS | Silent drop at debouncer entry — zero processing cost |

See [PRD.md §9](../PRD.md) for the full security model.

## Container Lifecycle

### How containers spin up and die

```
USER SENDS MESSAGE
        |
        v
HOST (Node process, always running)
  1. Router writes message to inbound.db (status: pending)
  2. Is container already running for this session?
     YES -> do nothing, container poll loop picks it up in <1s
     NO  -> spawn new container (docker run, ~3s cold start)
            - mounts session DBs
            - mounts group CLAUDE.md + skills
            - injects env vars (AWS creds, model, TZ)

CONTAINER (Docker, stays alive)
  3. agent-runner starts, polls inbound.db every 500ms
  4. Finds pending message -> calls Claude (via Claude Code subscription; OneCLI proxies the API)
  5. Writes response to outbound.db
  6. Goes back to polling... waiting for next message
  7. STAYS ALIVE until:
     - Idle timeout (no messages for ~30 min)
     - Host kills it (restart / deploy)
     - Container crashes
     - User runs `ncl groups restart`
  8. Heartbeat: touches /workspace/.heartbeat every few seconds
     Host sweep checks this - if stale >30min -> kills it

CONTAINER DIES
  9. Cleaned up (--rm flag)
  10. Next message arrives -> spawns fresh container (~3s)
  11. Session state preserved in inbound.db/outbound.db
      (DBs live on host, survive container restarts)
```

### Timeline of a typical day

| Time | Event | Container state |
|------|-------|-----------------|
| 07:00 | "good morning" on Telegram | Spawns (3s cold start), responds |
| 07:01 | "what's my schedule?" | Same container, instant response |
| 07:15 | Send a photo | Same container, calls vision model |
| 08:00 | No messages for 30 min | Host sweep kills container |
| 12:30 | "lunch recs?" | NEW container spawns (3s), full history preserved |
| 23:00 | Stop messaging | Idles out after 30 min, zero resources overnight |

### Key insight

The container is a **stateless worker** that clocks in when needed and clocks out when idle. Your data (conversation history, memory) lives in SQLite files on the host. The container is disposable — kill it anytime, next spawn picks up exactly where it left off.

## Auth Configuration

PocketClaw uses the **Claude Code subscription** path that ships with NanoClaw v2. The agent container talks to `api.anthropic.com` through the OneCLI proxy; OneCLI injects credentials at request time so no API key is passed in env vars or chat context.

First-time auth: when the host spawns the first agent container, run `claude /login` inside that container (or use the OneCLI web UI at `http://127.0.0.1:10254`). After that the credentials persist in the OneCLI vault and are reused on every subsequent container.

What this arch does **not** use:

- `ANTHROPIC_API_KEY` env var (subscription handles auth)
- `CLAUDE_CODE_USE_BEDROCK`, `AWS_*` env vars (Bedrock removed in the knowledge re-arch)
- `scripts/refresh-bedrock-creds.ps1` (deleted)
- `PocketClaw-RefreshBedrock` Windows Task Scheduler entry (delete it; it has nothing to refresh)

### Switching models

Models are configured per-agent-group via `ncl groups config update --model <model>`, not via `.env`. See `nanoclaw` documentation for the supported model identifiers.
