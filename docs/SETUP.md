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
| Claude Max subscription | $100/mo | required for the agent | https://claude.ai/upgrade |

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
ollama pull nomic-embed-text   # for mnemon embeddings
ollama pull llava              # for photo descriptions
```

## 3. Configure `.env`

Copy `.env.sample` → `.env` and fill in:

```bash
cp .env.sample .env
$EDITOR .env
```

Required at minimum:

- `ANTHROPIC_API_KEY` — Claude Max API key
- `TELEGRAM_BOT_TOKEN` (from @BotFather)
- `TELEGRAM_ALLOWED_CHAT_ID` (from @userinfobot)

Optional but recommended (cloud ingestion):

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — see `groups/pocketclaw/skills/auth/SKILL.md`
- `MS_CLIENT_ID` — see auth skill
- `APPLE_ID_EMAIL`, `APPLE_APP_PASSWORD` — see auth skill

## 4. Install mnemon

```bash
brew install mnemon-dev/tap/mnemon
# or: go install github.com/mnemon-dev/mnemon@latest
mnemon setup --target nanoclaw --yes
mnemon setup --embeddings ollama --model nomic-embed-text --endpoint http://localhost:11434
```

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

Now your wiki entries (auto-generated nightly at 03:00) sync peer-to-peer to your phone, tablet, second laptop — no cloud intermediary.

## 8. Verify scheduled jobs

After a few minutes, check `~/.pocketclaw/logs/audit.log` for:

```
2026-05-20T11:47:41Z | POCKETCLAW_START | cron driver running, jobs=cloud-ingest@02:00, wiki-regen@03:00, morning-digest@07:00
```

If that line is present, the three cron jobs are wired. They'll fire at 02:00 / 03:00 / 07:00 local time.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `pnpm install` hangs forever | exFAT drive without `node-linker=hoisted` | Confirm `.npmrc` has it |
| `better-sqlite3` compile error | Node version mismatch | Use Node 22 (`nvm use 22`) |
| Pre-push hook rejects branch | Branch not in allowed pattern | Rename to `feature/...`, `fix/...`, etc. |
| Telegram bot silent | Wrong `TELEGRAM_ALLOWED_CHAT_ID` | Check your chat id via @userinfobot |
| Photo not stored | Ollama not running on host | `ollama serve` then retry |
| Wiki entries empty | mnemon has no entities yet | Send a few `/memory <fact>` messages first |

See `docs/ARCHITECTURE.md` for the full data flow.
