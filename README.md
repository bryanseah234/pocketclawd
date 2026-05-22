# PocketClaw — Personal AI Assistant

Local-first personal assistant built on top of [NanoClaw v2](https://github.com/nanocoai/nanoclaw). Talks to you via Telegram + WhatsApp with shared memory across both, ingests email / calendar / contacts from Google / Microsoft / Apple, processes photos via local vision, and generates an Obsidian wiki you can sync peer-to-peer with Syncthing.

**Why local-first?** Only the final assembled prompt to Anthropic's API ever leaves your machine. Emails, photos, contacts, and files stay on disk in a folder you choose.

---

## Table of contents

- [Quick links](#quick-links)
- [Slash commands](#slash-commands)
- [Where data lives](#where-data-lives)
- [Project structure](#project-structure)
- [First-time setup](#first-time-setup)
- [Service lifecycle (install / start / stop / migrate)](#service-lifecycle)
- [Sign-in walkthroughs](#sign-in-walkthroughs)
- [Live ingestion sources](#live-ingestion-sources)
- [Day-to-day commands (`pnpm run …`)](#day-to-day-commands)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

---

## Quick links

- [docs/SETUP.md](docs/SETUP.md) — clone-to-first-message walkthrough
- [docs/SERVICE.md](docs/SERVICE.md) — Windows service lifecycle (install / migrate / teardown)
- [docs/POCKETCLAW.md](docs/POCKETCLAW.md) — PocketClaw-specific architecture
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — underlying NanoClaw architecture
- [PRD.md](PRD.md) — full product spec v3.0 + v1.1 extensions (§17)
- [CONTRIBUTING.md](CONTRIBUTING.md) — branch naming, commit format, PR flow

---

## Slash commands

Send these in Telegram or WhatsApp:

| Command | What it does |
|---------|--------------|
| `/memory <fact>` | Save a fact to mnemon |
| `/recall <query>` | Search the mnemon graph |
| `/wiki <topic>` | Regenerate Obsidian wiki entry for a topic |
| `/ingest` | Trigger immediate cloud ingestion (don't wait for 02:00 cron) |
| `/status` | Memory count, last ingest, vault counts, source health |
| `/digest` | Send morning digest now (auto-fires at 07:00 daily) |
| `/audit [date]` | Show audit log entries |
| `/auth google\|microsoft\|apple` | Start OAuth / device-code flow for that provider |
| `/photo <description>` | Manually save a photo description |
| `/minutes <meeting-name>` | Generate meeting minutes `.docx` from calendar + email context (§17.3) |
| `/research <topic>` | Generate research report PDF from local data only — no web search (§17.4) |
| `/slides <topic> [--style minimal\|corporate\|creative]` | Generate `.pptx` deck from mnemon (§17.5) |
| `/speech <topic> [--duration 5m] [--tone formal\|casual\|persuasive]` | Draft a speech as Markdown (§17.6) |

Beyond commands, PocketClaw also passively archives chat messages to mnemon when `INGEST_CHAT_MODE` is set in `.env`. See the [Chat archive](#chat-archive-telegram--whatsapp-passive-ingestion) section.

---

## Where data lives

PocketClaw keeps **everything on disk in one folder** that you control. Configurable via `.env`. By default it's `~/.pocketclaw/`, but you should put it on a drive with space — emails, vault wikis, presentations, and the mnemon graph will grow into GBs over time.

This install uses **`X:\PocketClawData\`** (~580 GB free). Layout:

```
X:\PocketClawData\
├── secrets\                      OAuth tokens (Google / Microsoft / Apple)
├── vault\                        Obsidian-compatible knowledge base
│   ├── wiki\                     auto-generated wiki entries (.md)
│   ├── meetings\                 /minutes outputs (.docx)
│   ├── research\                 /research PDF reports
│   ├── presentations\            /slides decks (.pptx)
│   └── speeches\                 /speech drafts (.md)
├── watch\                        files dropped here are auto-ingested
├── logs\                         service.stdout.log / service.stderr.log / audit.log
├── processed.db                  SHA256 fingerprints for file-watcher idempotency
└── mnemon\
    └── data\default\mnemon.db    the entire memory graph
```

The `.env` env-vars that control these paths:

```env
VAULT_PATH=X:/PocketClawData/vault
# IMPORTANT: MNEMON_DATA_DIR MUST be on an NTFS / ext4 / APFS volume.
# exFAT/FAT lacks SQLite WAL byte-range locks -> SQLITE_BUSY even when idle.
# On Windows, keep this on the OS drive (C:) even if other PocketClaw data
# lives on a secondary exFAT drive.
MNEMON_DATA_DIR=C:/Users/<you>/.mnemon-pocketclaw
MNEMON_DB_PATH=C:/Users/<you>/.mnemon-pocketclaw/data/default/mnemon.db
WATCH_PATHS_ROOT=X:/PocketClawData/watch
LOG_PATH=X:/PocketClawData/logs
POCKETCLAW_SECRETS_DIR=X:/PocketClawData/secrets
POCKETCLAW_PROCESSED_DB=X:/PocketClawData/processed.db
```

To move data to a different drive later, edit `.env`, run `pnpm svc:export` to bundle current state, copy the zip to the new location, run `migrate-import.ps1` (see [Service lifecycle](#service-lifecycle)).

> **Repo itself stays at `X:\01 REPOSITORIES\pocketclaw\`** — only the data lives at `X:\PocketClawData\`.

---

## Project structure

This repo is two things stacked:

1. **NanoClaw v2 harness** — `src/`, `container/`, `groups/global/`, `groups/main/`, channel adapters, host orchestration. Runs as a Node service.
2. **PocketClaw layer** — `groups/pocketclaw/` agent identity + skills, `src/modules/debouncer.ts`, `src/modules/photo-processor.ts`, `src/modules/ingestion/*`, `src/modules/wiki-generator.ts`, `src/modules/meeting-minutes.ts`, `src/modules/research-report.ts`, `src/modules/slide-generator.ts`, `src/modules/pocketclaw.ts` (cron driver).

Layout details:

- NanoClaw: [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)
- PocketClaw: [docs/POCKETCLAW.md](docs/POCKETCLAW.md)

---

## First-time setup

### Prerequisites

- Windows 10/11 with PowerShell 5.1+
- Admin rights for service registration (one-time, only for `pnpm svc:install`)
- [Node 22](https://nodejs.org/) (`.nvmrc` enforces this)
- [pnpm](https://pnpm.io/) (any 10.x; `package.json` pins `pnpm@10.33.0`)
- [mnemon](https://github.com/dipampaul17/mnemon) on PATH: `go install github.com/dipampaul17/mnemon@latest`
- [Ollama](https://ollama.com/) for local vision (`ollama pull llava`)
- A Telegram bot token (talk to `@BotFather` in Telegram)

### Steps

```powershell
# 1. Clone the repo (or you already have it)
cd "X:\01 REPOSITORIES\pocketclaw"

# 2. Install Node deps (skip-scripts because sharp's postinstall is buggy on Windows)
pnpm install --ignore-scripts --frozen-lockfile

# 3. Create your .env from the template
Copy-Item .env.example .env
# then edit .env — at minimum fill in:
#   TELEGRAM_BOT_TOKEN=...
#   TELEGRAM_ALLOWED_CHAT_ID=...
#   ANTHROPIC_API_KEY=... (or AWS Bedrock vars if using Claude on Bedrock)
# and update the path env-vars to point at your data drive (see "Where data lives")

# 4. Create your data root
New-Item -ItemType Directory -Path X:\PocketClawData -Force
foreach ($s in @("vault","secrets","logs","watch")) {
  New-Item -ItemType Directory -Path "X:\PocketClawData\$s" -Force
}

# 5. Build
pnpm run build

# 6. Run a one-off ingestion to verify everything wires up
pnpm ingest:now --hours 24
```

You should see facts ingest from any cloud source you've credentialed. Now register the long-running service (next section).

---

## Service lifecycle

PocketClaw runs as a Windows service (via [NSSM](https://nssm.cc/)) so the cron jobs (02:00 ingest / 03:00 wiki / 07:00 digest) fire automatically. All commands have `pnpm run` shortcuts:

### Install (one-time, needs admin)

```powershell
# From your normal (non-admin) PowerShell at the repo root:
pnpm svc:install:elevated
```

A UAC prompt pops up — click **Yes**. A new admin window opens, runs the install, and stays open with output visible. Press Enter when done to close it.

If you'd rather elevate manually:

```powershell
# Right-click PowerShell -> "Run as administrator", then:
cd "X:\01 REPOSITORIES\pocketclaw"
pnpm svc:install
```

> **Why elevation matters**: NSSM service registration calls `sc.exe create` which requires admin. The elevated wrapper handles `cd` to the repo for you so you don't get `ERR_PNPM_NO_PKG_MANIFEST` from `C:\WINDOWS\system32`.

This auto-installs NSSM (via Chocolatey or winget if missing), registers the `pocketclaw` service to start on boot, sets up log rotation at 10 MB, and starts the service.

### Day-to-day

```powershell
pnpm svc                 # one-shot status snapshot (no admin needed)
pnpm svc:status          # alias for pnpm svc
pnpm svc:tail            # tail logs in real time (Ctrl-C to stop)

# Stop/start/restart need admin:
nssm stop pocketclaw
nssm start pocketclaw
nssm restart pocketclaw
```

### After code changes

```powershell
pnpm run build
nssm restart pocketclaw   # admin
```

### After `.env` changes

```powershell
nssm restart pocketclaw   # admin
```

### Migrate to another machine

```powershell
# On THIS machine — bundle everything (creds + memory + vault):
pnpm svc:export
# -> pocketclaw-export-YYYYMMDD-HHMM.zip in current dir

# Copy zip to new machine. On NEW machine after cloning + pnpm install + build:
pnpm svc:install
# (run migrate-import.ps1 manually first if you want to restore data, see docs/SERVICE.md)

# Then on THIS machine, tear down:
pnpm svc:uninstall          # remove service, KEEP data
pnpm svc:uninstall:purge    # remove service AND wipe X:\PocketClawData
```

### Dry-run anything

```powershell
pnpm svc:install:dry        # see what install would do, no changes
```

Full lifecycle docs: [docs/SERVICE.md](docs/SERVICE.md).

---

## Sign-in walkthroughs

Each cloud source needs its own credential. PocketClaw never holds raw passwords — only OAuth tokens or app-specific passwords that you can revoke from the provider's portal.

### Google (Gmail + Calendar + Contacts) — easiest

1. [Google Cloud Console](https://console.cloud.google.com/) → create a new project (any name)
2. **APIs & Services → Library** → enable: `Gmail API`, `Google Calendar API`, `People API`
3. **APIs & Services → OAuth consent screen** → External, fill in app name + your email, save
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app**
5. Download the JSON, save as `X:\PocketClawData\secrets\google_credentials.json`
6. From Telegram or WhatsApp, send: `/auth google` — PocketClaw prints a URL, you sign in, paste the code back. Token caches at `X:\PocketClawData\secrets\google_token.json`.

### Microsoft (Outlook Mail + Calendar + Contacts) — currently parked

⚠️ **Code is built and ready, but Outlook ingestion is parked indefinitely.**

Microsoft's Entra app registration system has a tenant-lifecycle policy that automatically blocks personal-account "shadow tenants" after ~200 days of inactivity (error `AADSTS5000225`). For new personal accounts, the only way to register an app and use device-code flow is to phone Microsoft support and request manual reactivation within a 20-day window — this is documented at https://learn.microsoft.com/en-us/entra/fundamentals/inaccessible-tenant.

If you ever want to revisit, the options are:
- **Phone Microsoft support** with the AADSTS5000225 trace ID and ask for tenant reactivation (free, 15-30 min on the phone)
- **Subscribe to Microsoft 365 Personal** ($7/mo trial, free first month) — paid subscriptions auto-keep the tenant active
- **Use a corporate/school account** where app registration is allowed by IT
- Skip Outlook entirely — the rest of PocketClaw works fine without it

The ingester code at `src/modules/ingestion/microsoft.ts` and the `/auth microsoft` flow remain ready. Setting `MS_CLIENT_ID` in `.env` is enough to wake it up later.

### Apple (iCloud Mail + Calendar + Contacts)

Apple does NOT support OAuth for these APIs — only **app-specific passwords** with 2FA enabled.

1. [account.apple.com](https://account.apple.com) → **Sign-In and Security → App-Specific Passwords → Generate**
2. Label: `PocketClaw`. Apple shows the password ONCE — copy immediately.
3. In `.env`:
   ```env
   APPLE_ID_EMAIL=your.email@icloud.com
   APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
   ```
4. Restart service. No `/auth` flow needed — PocketClaw uses these on every IMAP/CalDAV/CardDAV connection.

### GitHub (PRs + commits + issues)

1. [github.com/settings/tokens](https://github.com/settings/tokens) → **Generate new token (classic)**
2. Scopes: `repo` (read) + `read:org`. Expiration: your choice (90 days is reasonable).
3. Copy the `ghp_...` token, paste into `.env` as `GITHUB_PAT=ghp_...`
4. Restart service.

### Slack (read your own channels)

⚠️ **Many corporate workspaces block this** via app-creation policy. Try in a personal/community workspace first.

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch** → pick the workspace
2. **OAuth & Permissions → User Token Scopes** (NOT Bot Token Scopes!) → add: `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `im:read`, `users:read`, `search:read`
3. **Install to Workspace → Allow** → copy the `xoxp-...` token
4. In `.env`:
   ```env
   SLACK_USER_TOKEN=xoxp-...
   SLACK_WORKSPACE=your-workspace-name
   ```
5. Restart service.

---

## Live ingestion sources

| Source | Status when fully credentialed | Pulls | Cron |
|---|---|---|---|
| Gmail | ✅ live | last 24h emails (sender, subject, body preview) | 02:00 daily |
| Google Calendar | ✅ live | upcoming 7 days of events | 02:00 daily |
| Google Contacts | ✅ live | full address book | 02:00 daily |
| Outlook Mail | ⏸ parked — see Microsoft walkthrough above for why | last 24h emails via Graph API | 02:00 daily |
| Outlook Calendar | ⏸ parked | upcoming 7 days of events | 02:00 daily |
| Outlook Contacts | ⏸ parked | full address book | 02:00 daily |
| iCloud Mail | ✅ live | last 24h via IMAP | 02:00 daily |
| iCloud Calendar | ✅ live | events via CalDAV | 02:00 daily |
| iCloud Contacts | ✅ live | contacts via CardDAV | 02:00 daily |
| GitHub PRs | ✅ live | recent + review-requested | 02:00 daily |
| GitHub Commits | ✅ live | last 24h push events | 02:00 daily |
| GitHub Issues | ✅ live | open + assigned to you | 02:00 daily |
| Slack | ⏸ needs `SLACK_USER_TOKEN` | recent messages from joined channels | 02:00 daily |
| Telegram chat archive | controlled by `INGEST_CHAT_MODE` | every inbound message (text + media metadata) | continuous (realtime hook) |
| WhatsApp chat archive | controlled by `INGEST_CHAT_MODE` | every inbound message (text + media metadata) | continuous (realtime hook) |
| File watcher | ✅ live | drop files into `X:\PocketClawData\watch\` | continuous |

Run `pnpm svc` for live status of each source.

---

## Chat archive (Telegram + WhatsApp passive ingestion)

Beyond the cron-based cloud sources above, PocketClaw can also archive **every chat message** in real time as it flows through Telegram or WhatsApp. This is **opt-in** via `INGEST_CHAT_MODE` in `.env`.

### Modes

| `INGEST_CHAT_MODE` | What gets archived to mnemon | Privacy |
|---|---|---|
| `off` (default) | Nothing — chat-archive is a no-op | Most private |
| `self` | Only messages YOU send | Privacy-respecting journal |
| `dms` | Self messages + 1-on-1 DMs from anyone | Group chats stay private |
| `all` | Every message in every chat you're in | **Privacy bombshell** (see below) |

### What gets stored

- Mnemon insight per message, tagged: `pocketclaw, src:whatsapp-chat` (or `telegram-chat`), `chat:<chatId>`, `kind:group|dm`, `from:self|other`, `sender:<id>`
- Format: `WhatsApp group "Family" — Bryan: just landed at SIN`
- Attachments are **noted but not downloaded** (just `[image]`, `[voice note]`, `[2 documents]` markers)
- Stickers and protocol messages are skipped
- Long bodies (>600 chars) get truncated
- Stored locally only — `C:\Users\<you>\.mnemon-pocketclaw\data\default\mnemon.db` (NTFS — must NOT be on exFAT)

### Privacy implications of `all` mode

If you set `INGEST_CHAT_MODE=all`:

- Your local mnemon DB will contain other people's messages — friends, family, group chats. They didn't consent to this.
- The mnemon DB is unencrypted SQLite. Anyone with access to your unlocked laptop can read it.
- This is legally loaded in many jurisdictions (EU GDPR informational duties, two-party-consent laws, etc.). You're responsible for compliance.
- Messages stay on your laptop unless you explicitly `/recall` them into a Claude prompt — at which point only the recalled facts go to the API (visible in `/audit`).

If any of that gives you pause, use `self` or `dms`. They're plenty useful as journal/note-stream tools.

### Enabling

```env
# .env
INGEST_CHAT_MODE=all
```

Restart service: `nssm restart pocketclaw` (admin). Within seconds of receiving the next chat message, mnemon will have a new insight tagged `src:<platform>-chat`. Verify:

```powershell
mnemon recall "<some keyword from a recent chat>" --limit 5
```

### Disabling at any time

Set `INGEST_CHAT_MODE=off` in `.env` and restart. Future messages stop being archived. Existing archived messages stay in mnemon — to wipe them you'd need to selectively delete via `mnemon` CLI, or `pnpm svc:uninstall:purge` for a full reset.

---

## Day-to-day commands

| Command | Purpose |
|---------|---------|
| `pnpm run dev` | Run host in foreground with hot reload (logs visible in your terminal) |
| `pnpm run build` | Compile TypeScript to `dist/` |
| `pnpm run start` | Run compiled host (what the service runs) |
| `pnpm test` | Run vitest suite |
| `pnpm ingest:now` | Run all ingesters once, write to mnemon (24h window) |
| `pnpm ingest:now --hours 1 --dry` | Quick smoke test, no mnemon writes |
| `pnpm svc` | Service status snapshot |
| `pnpm svc:tail` | Tail service logs in real time |
| `pnpm svc:install` | Register Windows service (admin) |
| `pnpm svc:install:elevated` | Register service with auto-UAC prompt (no need to start admin shell yourself) |
| `pnpm svc:install:dry` | Show install plan without applying |
| `pnpm svc:uninstall` | Remove service, keep data (admin) |
| `pnpm svc:uninstall:elevated` | Remove service with auto-UAC prompt |
| `pnpm svc:uninstall:purge` | Remove service and wipe data (admin) |
| `pnpm svc:export` | Bundle creds + memory + vault for migration |

---

## Troubleshooting

### Service won't start

```powershell
pnpm svc                 # check Status field
Get-Content X:\PocketClawData\logs\service.stderr.log -Tail 50
```

Common issues:
- `.env` missing → installer refuses; the error tells you exactly what's missing
- `dist/index.js` missing → run `pnpm run build` first
- mnemon not on PATH → cloud ingestion errors but service still runs

### Some sources show as `[ERR]` in `pnpm ingest:now`

Look at the error line:
- `MS_CLIENT_ID env var not set` → Outlook walkthrough above
- `Apple iCloud creds missing` → Apple walkthrough above
- `SLACK_USER_TOKEN not set` → Slack walkthrough above
- `Invalid Credentials` → token expired, re-run `/auth <provider>` from Telegram

### Mnemon recall returns nothing

Run `pnpm svc` — if `Insights` count is 0, ingestion hasn't fired yet. Trigger manually with `pnpm ingest:now`.

### Move data to a different drive

1. Stop service: `nssm stop pocketclaw`
2. Move folder: `Move-Item X:\PocketClawData D:\PocketClawData`
3. Update `.env` — change every `X:/PocketClawData` to `D:/PocketClawData`
4. `pnpm run build && nssm start pocketclaw`

### Disk getting full

The big consumers, in order:
1. `X:\PocketClawData\mnemon\` — the memory graph. Grows ~1 KB per fact. 100k facts ≈ 100 MB.
2. `X:\PocketClawData\vault\research\` — PDFs from `/research`, ~50-200 KB each
3. `X:\PocketClawData\vault\presentations\` — PPTX, ~50-100 KB each
4. `X:\PocketClawData\logs\` — capped at 10 MB rotation by NSSM

To reclaim space: delete unwanted vault files manually (won't affect mnemon), or `pnpm svc:uninstall:purge` for a full reset.

Full troubleshooting: [docs/SERVICE.md#troubleshooting](docs/SERVICE.md#troubleshooting).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming (`feature/xxx`), commit format (Conventional Commits, ≤72 chars), and PR flow.
