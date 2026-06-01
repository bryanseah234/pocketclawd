---
name: status
description: Show Clawd runtime health. Use when the user types `/status`, asks "are you up?", "what's your memory count?", "how many facts have you ingested?", "when was the last ingestion?", or wants a quick health check.
---

# /status — Clawd Health Check

## When to invoke

- User types: `/status` in Telegram or WhatsApp
- User asks: "how are you?", "are you working?", "what's your status?"
- User asks: "how many facts do you remember?", "what's in your memory?"
- User asks: "when was the last ingestion?", "is the cron running?"

## Behaviour

Run a quick read-only health check across the knowledge base + the file system, then reply with a compact human-readable summary. No mutations, no LLM beyond formatting the response.

## Implementation steps

### 1. `kb_status` — get total insight count + top entities

Call the MCP tool `kb_status({})`. It returns `{ total, topEntities: [{ entity, count }, ...] }`.

If you want a longer entity list (top 20 instead of top 10), use `kb_list_top_entities({ limit: 20 })` instead.

### 2. Read audit log — find last ingestion run

The audit log lives at `${LOG_PATH}/audit.log` (LOG_PATH from env, defaults to `~/.clawd/logs/`). Read the last 20 lines and pull out the most recent line containing `cloud-ingest` or `runAll`.

```bash
tail -n 20 "$LOG_PATH/audit.log"
```

If the file does not exist, say "no audit log yet — service may not have fired a cron yet".

### 3. Count vault artifacts by category

```bash
ls "$VAULT_PATH/wiki"          | wc -l   # wiki entries
ls "$VAULT_PATH/meetings"      | wc -l   # /minutes outputs
ls "$VAULT_PATH/research"      | wc -l   # /research PDFs
ls "$VAULT_PATH/presentations" | wc -l   # /slides PPTX
ls "$VAULT_PATH/speeches"      | wc -l   # /speech markdown
```

Surface counts only — never list filenames (privacy in chat history).

### 4. Source live/parked status

Compute from the env file:

| Source | Live if | Parked if |
|---|---|---|
| Google (Gmail / GCal / GContacts) | `~/.clawd/secrets/google_token.json` exists OR `CLAWD_SECRETS_DIR/google_token.json` exists | else |
| Microsoft (Outlook x3) | `MS_CLIENT_ID` is set AND non-empty | else |
| GitHub (PRs / commits / issues) | `GITHUB_PAT` set | else |
| Slack | `SLACK_USER_TOKEN` set | else |

### 5. Format reply

Produce a compact message that fits in one Telegram bubble (≤2000 chars). Use platform-native formatting:

- **Telegram** (Markdown V2): `*bold*`, code blocks via triple backticks. Escape `_*[]()~>#+-=|{}.!` outside code blocks.
- **WhatsApp** (plain): no markdown; use `-` for bullets and emoji.

### Example reply (Telegram)

```
*Clawd status*
🧠 Memory: 204 insights
📂 Vault: 1 wiki · 1 minutes · 1 research · 1 slides · 0 speeches
🕐 Last ingest: 2026-05-21 22:15 (47 min ago)
🔝 Top entities: GitHub, gmail, Clawd, README, mail

Parked: Outlook ⏸ ×3 · Slack ⏸ ×1
```

### Example reply (WhatsApp)

```
Clawd status
- Memory: 204 insights
- Vault: wiki=1 minutes=1 research=1 slides=1 speeches=0
- Last ingest: 22:15 (47 min ago)
- Top entities: GitHub, gmail, Clawd, README, mail

Parked: Outlook x3, Slack x1
```

## Must-do

- Reply within 5 seconds (it's a status check, not a search).
- Always show memory count + last-ingest time at minimum.
- Adapt formatting for the calling channel (Telegram Markdown V2 vs WhatsApp plain).
- Use the parsed `kb_status` result — never hard-code numbers.

## Must-not-do

- Don't expose absolute paths in the reply (privacy in chat history).
- Don't include credentials, tokens, or chat IDs.
- Don't kick off a fresh ingestion as part of /status — that's what `/ingest` is for.
- Don't include internal entity-count noise (top 5 only, no full list).
- Don't list vault filenames — counts only.
- Don't reference `mnemon` — that engine is gone, replaced by `kb_*` MCP tools backed by pgvector.
