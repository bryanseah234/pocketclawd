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
  4. Finds pending message -> calls Claude (Haiku on Bedrock)
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

### Default: AWS Bedrock (Haiku 4.5)

```env
CLAUDE_CODE_USE_BEDROCK=1
ANTHROPIC_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0
AWS_ACCESS_KEY_ID=...   # auto-refreshed by scripts/refresh-bedrock-creds.ps1
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...
AWS_REGION=us-east-1
```

- Credentials auto-refresh every 30 min via Windows Task Scheduler (`PocketClaw-RefreshBedrock`)
- SSO session lasts ~8-16h; after that run `aws sso login --sso-session pocketclaw`
- Cost: ~$0.001/message (Haiku is 20x cheaper than Sonnet)

### Backup: Claude Pro (Haiku 4.5)

If Bedrock is unavailable, restore Claude Pro auth:

```powershell
Copy-Item "data\.credentials.json.backup" "data\v2-sessions\ag-1779335520163-gzrk2c\.claude-shared\.credentials.json"
```

Model forced to Haiku via `settings.json` — won't burn your Pro token quota.

### Switching models

Edit `.env` and restart the host:

```env
# Haiku (fast, cheap — default)
ANTHROPIC_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0

# Sonnet (smarter, 20x more expensive)
ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250514-v1:0

# Opus (smartest, 100x more expensive)
ANTHROPIC_MODEL=us.anthropic.claude-opus-4-5-20251101-v1:0
```
