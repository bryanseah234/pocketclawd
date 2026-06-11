# Dev Setup

## Requirements

- Node 22 (see .nvmrc) -- do not use Node 26, better-sqlite3 will not compile
- pnpm
- Python 3.12
- uv (Python package manager)
- Docker (for local sub-agent testing)
- AWS credentials configured for ap-southeast-1, profile clawd-prod

## Clone and install

```bash
git clone git@github.com:bryanseah234/pocketclawd.git
cd pocketclawd
pnpm install
cd container/sub-agent && uv sync && cd ../..
```

ExFAT drives (X: on Windows) require node-linker=hoisted in .npmrc.
The repo already has this set.

## Environment

```bash
cp .env.example .env
```

Required keys in .env:
- AWS_REGION=ap-southeast-1
- AWS_PROFILE=clawd-prod
- REDIS_URL (ElastiCache URL or local Redis for dev)
- DATA_BUCKET=nanoclaw-data-709609992277
- DYNAMODB_CHAT_TABLE=nanoclaw-chat-messages
- DYNAMODB_PREFS_TABLE=nanoclaw-user-preferences
- OPENSEARCH_ENDPOINT (AOSS endpoint)
- TELEGRAM_BOT_TOKEN
- NANOCLAW_ENV=cloud
- SKIP_CONTAINER_RUNTIME_CHECK=1

## Build and run

```bash
pnpm build
pnpm start
```

## Tests

```bash
# Orchestrator
pnpm test

# Sub-agent
cd container/sub-agent && uv run pytest

# Full beta suite (requires live AWS + running service)
cd test && python full_suite_runner.py
```

## Pre-commit hooks

```bash
bash scripts/setup_hooks.sh         # Linux / macOS / WSL
powershell scripts/setup_hooks.ps1  # Windows
```

## Windows notes

The terminal tool runs git-bash (MSYS) which sometimes hits a DLL fork bug
(dofork: child died unexpectedly). Workaround: use Python subprocess via
execute_code for file I/O and shell commands.

On a host where git-bash is unreliable, drive git via PowerShell or push
individual files through the GitHub contents API.

## Sub-agent local Docker run

```bash
docker build -t nanoclaw-agent container/sub-agent/
docker run --env-file container/sub-agent/.env -p 8000:8000 nanoclaw-agent
```

Requires REDIS_URL, DATA_BUCKET, OPENSEARCH_ENDPOINT, and AWS credentials
(env vars or instance profile).

## Admin dashboard

http://localhost:3000/admin after pnpm start.
Basic auth: admin / value from ADMIN_PASS in .env.
