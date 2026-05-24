# PocketClaw Windows Service Lifecycle

PocketClaw runs as a long-lived Windows service via [NSSM](https://nssm.cc/) so that the cron jobs (02:00 cloud ingestion, 03:00 wiki regeneration, 07:00 morning digest) fire on schedule without you keeping a terminal open.

This document covers **install / status / uninstall / migrate** — every script lives under `scripts/service/`.

---

## Prerequisites

- Windows 10/11 with PowerShell 5.1+
- Admin rights (NSSM service registration needs them)
- Node 22 on PATH (`node --version` should report `v22.x`)
- pnpm + a successful `pnpm run build` (so `dist/index.js` exists)
- `.env` filled in (at minimum `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID`, plus any cloud credentials you've configured)
- Docker Desktop running (PocketClaw's knowledge base is a Postgres + pgvector container)

NSSM itself is auto-installed by `install.ps1` via Chocolatey or winget.

---

## Quick start

```powershell
# From an ELEVATED PowerShell (Run as Administrator), at repo root:
.\scripts\service\install.ps1
```

That single command:
1. Verifies prereqs (Node 22, build artifacts, .env, Docker)
2. Auto-installs NSSM if missing
3. Registers a service named `pocketclaw` set to auto-start on boot
4. Pipes stdout/stderr to `~/.pocketclaw/logs/service.{stdout,stderr}.log` with 10 MB rotation
5. Sets `AppRestartDelay=10000` so it self-heals 10s after any crash
6. Starts the service

Verify:

```powershell
.\scripts\service\status.ps1
```

You should see `Status: Running` and a PID.

---

## Day-to-day

### Status

```powershell
.\scripts\service\status.ps1
.\scripts\service\status.ps1 -Tail 100
.\scripts\service\status.ps1 -Follow      # tail logs in real time, Ctrl-C to stop
```

### Stop / start / restart

```powershell
# Need elevated PowerShell for these:
nssm stop pocketclaw
nssm start pocketclaw
nssm restart pocketclaw
```

### View logs

```powershell
Get-Content $env:USERPROFILE\.pocketclaw\logs\service.stdout.log -Tail 50 -Wait
Get-Content $env:USERPROFILE\.pocketclaw\logs\service.stderr.log -Tail 50 -Wait
Get-Content $env:USERPROFILE\.pocketclaw\logs\audit.log -Tail 50 -Wait      # cron + ingest events
```

### Reconfigure after `.env` changes

The service reads `.env` at startup, so any credential change requires a restart:

```powershell
nssm restart pocketclaw
```

### Reinstall after code changes

```powershell
pnpm run build
.\scripts\service\install.ps1   # idempotent, will re-register
```

---

## Teardown

### Just stop using PocketClaw, keep the data

```powershell
.\scripts\service\uninstall.ps1
```

This removes the service registration but **leaves**:
- `.env` at repo root
- `~/.pocketclaw/` (vault, secrets, logs, watch, processed.db)
- The `pocketclaw_pgdata` Docker volume (knowledge base — managed by docker compose)

You can reinstall later with `install.ps1` and pick up where you left off.

### Wipe everything

```powershell
.\scripts\service\uninstall.ps1 -Purge
```

`-Purge` deletes `~/.pocketclaw/` (the `pocketclaw_pgdata` Docker volume is left alone — drop it manually with `docker volume rm pocketclaw_pgdata` if you want it gone) **after a `yes` confirmation prompt**. The repo itself, your `.env` file, and any migration zips are NOT touched.

### Just want to see what would happen

```powershell
.\scripts\service\install.ps1 -DryRun
.\scripts\service\uninstall.ps1 -DryRun
.\scripts\service\uninstall.ps1 -Purge -DryRun
```

All scripts support `-DryRun` and exit without applying.

---

## Migrating to another machine

This is the workflow you asked for: testing on this laptop, moving to a real machine later.

### On the source machine

```powershell
# Optional: stop the service first so .env / secrets / knowledge base aren't in flux
nssm stop pocketclaw

# Bundle everything
.\scripts\service\migrate-export.ps1
# Output: pocketclaw-export-YYYYMMDD-HHMM.zip in current directory
```

The zip contains:
- `.env`
- `secrets/` (Google + Microsoft + Apple OAuth tokens)
- `vault/` (wiki, meetings, research, slides, speeches) — pass `-SkipVault` to omit
- `pocketclaw-pgdump.sql` (pg_dump of the knowledge-base database) — pass `-SkipKnowledgeBase` to omit
- `MANIFEST.json` (source machine, Node version, Postgres image tag, timestamp)
- `README.txt` (restore instructions)

### Move the zip

USB drive, OneDrive, scp, whatever you prefer. The zip is fully portable.

### On the destination machine

1. Clone the pocketclaw repo to wherever you want
2. Install Node 22, pnpm, Docker Desktop (same as source)
3. `pnpm install --ignore-scripts && pnpm run build`
4. Unzip the export somewhere (e.g. `C:\temp\pocketclaw-export\`)
5. Restore data:
   ```powershell
   .\scripts\service\migrate-import.ps1 -ExportDir C:\temp\pocketclaw-export
   ```
6. Install the service (elevated):
   ```powershell
   .\scripts\service\install.ps1
   ```

The new machine now has all your accumulated knowledge-base entries, the same OAuth tokens (no need to re-`/auth`), and the same vault.

### Optional: tear down the source machine

After confirming the destination is working:

```powershell
.\scripts\service\uninstall.ps1 -Purge
```

---

## Troubleshooting

### Service won't start

```powershell
.\scripts\service\status.ps1                    # check Status field
Get-Content $env:USERPROFILE\.pocketclaw\logs\service.stderr.log -Tail 50
```

Common causes:
- `.env` missing → script refuses to install, will tell you
- `dist/index.js` missing → run `pnpm run build`
- Node not on PATH → check `where.exe node`
- Postgres container not running → ingestion will error, but the service itself still runs (`docker compose up -d postgres`)

### Service keeps restarting (NSSM `AppRestartDelay` keeps relaunching after crash)

Check stderr log. Typical issues:
- `better-sqlite3` native binding broken — see `.omo/notepads/pocketclaw/blockers.md` for Node version issues
- Telegram bot token revoked → service errors out on first message poll
- Port already in use (some adapter wants a port) → check `netstat -an | findstr :PORT`

If you genuinely want the service to stop trying:

```powershell
nssm set pocketclaw AppExit Default Exit
nssm restart pocketclaw
```

### NSSM not found after install

```powershell
# Refresh PATH in current shell
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
```

Or just open a new PowerShell window.

### Service logs growing too large

NSSM is set to rotate at 10 MB. To reduce further:

```powershell
nssm set pocketclaw AppRotateBytes 1048576    # 1 MB
nssm restart pocketclaw
```

To clear logs manually:

```powershell
Remove-Item $env:USERPROFILE\.pocketclaw\logs\service.*.log
nssm restart pocketclaw
```

---

## Why NSSM and not a native Windows service?

NSSM wraps a regular executable as a service. PocketClaw's host is a Node script, not a native `*.exe` that knows how to be a service, so we need a wrapper. Alternatives we considered:

- **Task Scheduler** — auto-start on logon works but doesn't survive logoff, no built-in restart-on-crash, harder to read logs.
- **`sc.exe create` directly** — needs the binary itself to handle the SCM protocol; Node doesn't.
- **`pm2-windows-service`** — adds another runtime + global pnpm install; we already have pnpm and want fewer moving parts.

NSSM is single-binary, well-maintained, and supported by both Chocolatey and winget for clean install/uninstall.
