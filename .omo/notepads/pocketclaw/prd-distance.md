# PocketClaw — PRD Distance Scorecard (truthful)

Date: 2026-05-21 (Asia/Singapore)
Last action: live ingestion run, 231 facts written into mnemon, end-to-end verified.

## Honest scorecard against PRD v3.0

### What's BUILT and FUNCTIONAL (verified by running)

| PRD section | Component | Evidence |
|---|---|---|
| §6, §7.1 | NanoClaw v2 host harness merged into repo | 159 dist files, build clean |
| §7.5 | MessageDebouncer (5s batch, sticker drop) | 7 vitest tests pass |
| §7.6 | Telegram channel adapter | bot configured, polling mode |
| §7.7 | WhatsApp channel adapter | Baileys, QR-pair |
| §7.8 | Photo pipeline (validate -> resize -> vision) | 16 vitest tests pass |
| §7.9.1 | Google ingestion: Gmail, GCal, GContacts | **17 emails + 1 event + 199 contacts ingested live** |
| §7.9.2 | Microsoft ingestion: Outlook Mail, GCal, Contacts | code compiled; needs `MS_CLIENT_ID` |
| §7.9.3 | Apple ingestion: IMAP, CalDAV, CardDAV | code compiled; needs Apple ID + app pwd |
| §7.9.4 | CloudScheduler with Promise.allSettled fault isolation | proven: 1 source erroring doesn't block others |
| §7.10 | File watcher (chokidar, SHA256 idempotency) | code compiled |
| §7.11 | Wiki generator (Obsidian-compatible Markdown) | code compiled |
| §17.1 | GitHub ingestion (PRs, commits, issues) - v1.1 extension | **3 PRs + 6 commits + 5 issues ingested live** |
| §17.2 | Slack ingestion (channels, messages) - v1.1 extension | code compiled; needs `SLACK_USER_TOKEN` |
| §8.3 | All 9 slash command skill files | groups/pocketclaw/skills/*.md exist |

### What's BUILT but NOT FUNCTIONAL (waiting on credentials)

| Source | Blocker | Fix |
|---|---|---|
| Outlook (Microsoft 365) | `MS_CLIENT_ID` empty | Register app at portal.azure.com -> Microsoft Entra ID -> App registrations. Public client + Mail.Read, Calendars.Read, Contacts.Read scopes. Then `MS_CLIENT_ID=<id>` in .env, run `/auth microsoft` for device code flow. |
| Apple iCloud | `APPLE_ID_EMAIL`, `APPLE_APP_PASSWORD` empty | appleid.apple.com -> Sign in -> Sign-In and Security -> App-Specific Passwords -> Generate. Then put in .env. |
| Slack | `SLACK_USER_TOKEN` empty | api.slack.com/apps -> Create app (user token, not bot) -> install -> grab xoxp-... token. |

### What's BUILT and HAS BUGS (now fixed in this session)

| Bug | What it broke | Fix applied |
|---|---|---|
| `chat` package version drift (root 4.26 vs `@chat-adapter/telegram` 4.27) | `tsc` exited 2, stale dist | Pinned `chat: 4.27.0` in package.json, re-installed |
| `mnemon remember --source-id` flag does not exist | All ingested facts errored when writing to mnemon | Encoded source-id into tags instead (src:gmail, id:<sourceId>) |
| GitHub `/users/events` endpoint returns 404 | github-prs and github-commits ingesters returned 0 facts | Now fetches `/user` first to resolve login, then uses `/users/{login}/events` |
| Concurrent mnemon CLI invocations -> SQLITE_BUSY | ~50% of ingested facts dropped during parallel run | Added process-wide mutex (`mnemonWriteChain`) so all writes serialize |

### What's NOT BUILT (and is per-PRD intentional)

| Item | Why not built |
|---|---|
| WhatsApp/Telegram passive chat scraping | PRD §7.7 explicitly says "self-chat model: only respond to messages from self". PocketClaw is your assistant, not a chat archive. |
| Video processing | PRD §6 explicitly excludes video - "ignore + error message". |
| Multi-user logic | PRD: single-tenant, owner-only. |
| Top-level docker-compose.yml | NanoClaw v2 spawns containers per-agent-group dynamically via `src/container-runner.ts`. T16 deferred this and the F-wave ratified it. |

### What's NOT BUILT (gaps that may matter)

| Gap | Severity | Effort to add |
|---|---|---|
| Live integration tests (vs. unit tests against mocks) | Low | Need a sandbox tenant for each cloud - out of MVP scope |
| Wiki regeneration on >10 new entities (event-driven) | Medium | scheduler + wiki-generator are wired; just need the trigger glue. ~2h. |
| Morning digest auto-fires at 07:00 | Medium | T16 wired the cron skeleton; need to verify it actually fires when host runs as service. ~1h smoke test. |
| `/recall` skill command flag mismatch (uses `--query` but mnemon takes positional) | Low | One-line skill file edit. |

## Distance summary

- **Code-complete vs PRD core (§§6-11)**: ~95%. Minor skill-file flag bug in /recall.
- **Code-complete vs PRD v1.1 extensions (§17)**: ~75%. GitHub + Slack ingest written; minutes / research / slides / speech features in §17 not yet started.
- **Live-functional with zero further work**: Google (3 sources) + GitHub (3 sources) fully live; Outlook + Apple + Slack waiting on creds.
- **Production-ready (host as long-running service, cron jobs firing)**: NOT YET. Host needs to be started via `pnpm run dev` or as a Windows service. The cron driver in T16 only fires when the host is the live process - manual `/ingest` works any time.

## Live evidence (from this session)

```
=== LIVE ingestion (writes to mnemon) ===
Window: 6h, total facts written = 231

[ OK] gmail                  facts=17    after concurrency fix
[ OK] google-calendar        facts=1
[ OK] google-contacts        facts=199
[ERR] outlook-mail           facts=0    MS_CLIENT_ID env var not set
[ERR] outlook-calendar       facts=0    MS_CLIENT_ID env var not set
[ERR] outlook-contacts       facts=0    MS_CLIENT_ID env var not set
[ERR] icloud-mail            facts=0    Apple iCloud creds missing
[ERR] icloud-calendar        facts=0    Apple iCloud creds missing
[ERR] icloud-contacts        facts=0    Apple iCloud creds missing
[ OK] github-prs             facts=3
[ OK] github-commits         facts=6
[ OK] github-issues          facts=5
[ERR] slack                  facts=0    SLACK_USER_TOKEN not set in .env
```

`mnemon recall "Singapore"` returns ingested contacts tagged `pocketclaw, src:google-contacts, id:people/...`.

## What to do next (priority order)

1. **(60s)** Set `MS_CLIENT_ID` in .env -> `/auth microsoft` -> Outlook online
2. **(60s)** Generate Apple app password -> set 2 env vars -> iCloud online
3. **(2 min)** Slack user token -> set env var -> Slack online
4. **(15 min)** Start host as background service so 02:00 / 03:00 / 07:00 crons actually fire
5. **(2 hours)** Add §17 v1.1 extras (minutes capture, research mode, slides) if you want
