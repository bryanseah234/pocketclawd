# PocketClaw — Setup Guide

A step-by-step walkthrough from clean machine to your first message. Total time: ~30 min (most of it waiting for `pnpm install`).

## Prerequisites

| Tool | macOS | Linux | Windows |
|------|-------|-------|---------|
| Docker Desktop | `brew install --cask docker` | [docs.docker.com](https://docs.docker.com/engine/install) | [docker.com/desktop](https://docker.com/desktop) |
| Node.js 22 LTS | `brew install node@22` | `apt install nodejs` | [nodejs.org](https://nodejs.org) |
| pnpm 10+ | `npm install -g pnpm` | same | same |
| Ollama | `brew install ollama` | curl `https://ollama.com/install.sh` | [ollama.com](https://ollama.com) |
| Syncthing | `brew install syncthing` | `apt install syncthing` | [syncthing.net](https://syncthing.net) |
| Obsidian | [obsidian.md](https://obsidian.md) | same | same |
| Claude Code subscription | $100/mo (Max) | required for the agent | https://claude.ai/upgrade |

> **Important**: PocketClaw is pinned to Node **22**. Running it on Node ≥ 26 will fail to compile `better-sqlite3@11`. Check `node --version` matches `.nvmrc`.

## 1. Clone + install

```bash
git clone https://github.com/<your-fork>/pocketclaw.git
cd pocketclaw
./scripts/setup_hooks.sh    # macOS / Linux
./scripts/setup_hooks.ps1   # Windows
pnpm install
pnpm run build
```

If you're on an exFAT/FAT drive (no symlinks), `.npmrc` already sets `node-linker=hoisted`. Expect 5-10 min on slow drives.

## 2. Pull Ollama models

```bash
ollama pull nomic-embed-text   # for knowledge-base embeddings (768-dim)
ollama pull llava              # for photo descriptions
```

## 3. Start Postgres + pgvector

PocketClaw stores its knowledge base in a single Postgres container with the `pgvector` extension. The container ships in the repo's `docker-compose.yml` and listens on `127.0.0.1:5432` only.

```bash
docker compose up -d postgres
```

Schema is applied on first start from `src/db/postgres-migrations/001_init.sql` (creates the `knowledge` table, `vector(768)` column, HNSW index, and `(source, source_id)` upsert key).

Sanity check:

```bash
docker compose exec postgres psql -U pocketclaw -d pocketclaw -c '\dx'
# vector | <ver> | public | vector data type and ivfflat / hnsw access methods
```

> **Why a real database, not embedded SQLite?** Embedding-vector search needs `pgvector` HNSW indexes; SQLite has no equivalent that scales past a few thousand facts. Postgres also gives us proper indexes, transactions, and a stable backup story (`pg_dump`).

## 4. Configure `.env`

Copy `.env.sample` → `.env` and fill in:

```bash
cp .env.sample .env
$EDITOR .env
```

Required at minimum:

- `TELEGRAM_BOT_TOKEN` (from @BotFather)
- `TELEGRAM_ALLOWED_CHAT_ID` (from @userinfobot)

Authenticate Claude Code via the subscription path the first time the host spawns an agent container (`claude /login` inside the container, or use OneCLI). No `ANTHROPIC_API_KEY` or AWS Bedrock vars are required — those are gone in the current arch.

Optional but recommended (cloud ingestion):

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — see `groups/pocketclaw/skills/auth/SKILL.md`
- `MS_CLIENT_ID` — see auth skill
- `APPLE_ID_EMAIL`, `APPLE_APP_PASSWORD` — see auth skill
- `WHATSAPP_AUTH_DIR` — Baileys session path; defaults to `~/.pocketclaw/whatsapp/`

## 5. Run the host

```bash
pnpm run dev
```

The host opens an outbound websocket to Telegram (long polling — no inbound port required) and listens for messages from your allowlisted chat.

## 6. First message

Send `/start` to your bot in Telegram. PocketClaw should reply with a greeting and run the `init-first-agent` flow.

## 7. (Optional) Set up Obsidian + Syncthing

```bash
# 1. Install Obsidian and open the vault at $VAULT_PATH (default: ~/.pocketclaw/vault)
# 2. Install plugins: Dataview, Graph View, Calendar, Tag Wrangler
# 3. Start Syncthing on each device
syncthing
# 4. Add vault folder via Syncthing's web UI at http://127.0.0.1:8384
# 5. Pair devices via Syncthing device IDs
```

Now your wiki entries (auto-generated nightly at 03:00, currently a host-side no-op pending re-wiring through the agent container) sync peer-to-peer to your phone, tablet, second laptop — no cloud intermediary.

## 8. Verify scheduled jobs

After a few minutes, check `~/.pocketclaw/logs/audit.log` for:

```
2026-05-20T11:47:41Z | POCKETCLAW_START | cron driver running, jobs=cloud-ingest@02:00, wiki-regen@03:00, morning-digest@07:00
```

If that line is present, the three cron jobs are wired. They'll fire at 02:00 / 03:00 / 07:00 local time. Cloud ingest writes facts into the knowledge base; wiki-regen and morning-digest currently log `SKIP | no-provider` / `SKIP | no-handler` until they're re-routed through the agent container (post-rearch follow-on).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `pnpm install` hangs forever | exFAT drive without `node-linker=hoisted` | Confirm `.npmrc` has it |
| `docker compose up -d postgres` exits immediately | Port 5432 already in use | Stop the conflicting Postgres or change the published port in `docker-compose.yml` |
| `pgvector` extension missing | Wrong Postgres image | The compose file pins `pgvector/pgvector:pg16` — don't substitute vanilla `postgres:16` |
| `better-sqlite3` compile error | Node version mismatch | Use Node 22 (`nvm use 22`) |
| Pre-push hook rejects branch | Branch not in allowed pattern | Rename to `feature/...`, `fix/...`, etc. |
| Telegram bot silent | Wrong `TELEGRAM_ALLOWED_CHAT_ID` | Check your chat id via @userinfobot |
| Photo not stored | Ollama not running on host | `ollama serve` then retry |
| Wiki entries empty | Knowledge base has no entries yet | Send a few `/memory <fact>` messages first |

See `docs/ARCHITECTURE.md` for the full data flow.
