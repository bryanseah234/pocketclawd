# PocketClaw — Personal AI Assistant

## TL;DR

> **Quick Summary**: Build PocketClaw by merging `nanocoai/nanoclaw` into this repo as the base
> harness, then layering PocketClaw-specific behaviour on top: install Telegram + WhatsApp via
> NanoClaw's `/add-*` skill system, add a custom `groups/pocketclaw/` agent group with all PRD
> directives, and implement photo processing, cloud ingestion, file discovery, and wiki generation
> as TypeScript modules inside NanoClaw's `src/modules/` convention.
>
> **Deliverables**:
> - NanoClaw merged into repo (src/ container/ groups/ CLAUDE.md package.json)
> - `groups/pocketclaw/CLAUDE.md` — PocketClaw agent identity (PRD §7.2)
> - Telegram channel adapter installed via NanoClaw `/add-telegram` skill
> - WhatsApp channel adapter installed via NanoClaw `/add-whatsapp` skill
> - `src/modules/debouncer.ts` — 5s unified batch queue
> - `src/modules/photo-processor.ts` — vision pipeline
> - `src/modules/ingestion/` — Google, Microsoft, Apple, file-watcher, scheduler
> - `src/modules/wiki-generator.ts` — Obsidian Markdown with WikiLinks
> - `groups/pocketclaw/skills/` — /memory /recall /wiki /ingest /status /digest /audit /auth
> - docker-compose.yml extended with vault, mnemon, watch, photo-cache volumes
> - Vitest test suite matching NanoClaw's `*.test.ts` convention
> - docs/SETUP.md, docs/ARCHITECTURE.md, docs/OBSIDIAN_SETUP.md
>
> **Estimated Effort**: XL (20 tasks across 5 waves)
> **Parallel Execution**: YES — 5 waves
> **Critical Path**: T0 → T1 → T2,T5,T6,T7 → T9,T10,T11,T12,T13 → T18 → F1-F4

---

## Context

### Original Request
Build PocketClaw per PRD v3.0 (PRD.md). This repo is a blank Azure ML template.
NanoClaw (`nanocoai/nanoclaw`) is the actual base harness to merge in first.

### Research Findings
**NanoClaw architecture** (`nanocoai/nanoclaw`):
- Node.js/TypeScript host, pnpm, Bun inside container, vitest for tests
- `src/` — host-side router, delivery, session-manager, container-runner, db/
- `src/channels/` — channel adapter registry (adapters installed via skills)
- `src/modules/` — custom business logic modules
- `container/agent-runner/` — Bun agent-runner inside Docker
- `groups/<name>/` — per-agent-group: CLAUDE.md, skills/, container config
- Skill installation: Claude Code slash commands copy modules into fork
- `nanocoai/nanoclaw-telegram` — Telegram skill (channels branch)
- `nanocoai/nanoclaw-whatsapp` — WhatsApp skill (channels branch)

**This repo (pocketclaw)**:
- Blank Azure ML Python template — provides conventional commits, pre-commit, DVC
- Python conventions preserved but NanoClaw TypeScript conventions dominate
- `PRD.md` §MANDATORY ONBOARDING: repo conventions win over PRD on conflicts

### Key Conflicts Resolved
| PRD says | Reality | Resolution |
|----------|---------|------------|
| Python 3.12 for all code | Repo is Python 3.13 + NanoClaw is TypeScript | TypeScript for all NanoClaw modules; Python only if no TS lib exists |
| `queue/debouncer.py` | NanoClaw convention is TypeScript | `src/modules/debouncer.ts` |
| `ingestion/cloud_scheduler.py` | Same | `src/modules/ingestion/scheduler.ts` |
| Clone NanoClaw repo | Already in pocketclaw template | Merge via git remote |
| `/add-telegram` assumes NanoClaw skill system | Skill system didn't exist in template | T1 brings NanoClaw in first; T5/T6 then run the skills |

---

## Work Objectives

### Core Objective
Merge NanoClaw into pocketclaw, configure a `groups/pocketclaw/` agent group, install
Telegram + WhatsApp channels, and add all PocketClaw-specific modules (debouncer, photo,
ingestion, wiki) as TypeScript modules following NanoClaw's `src/modules/` pattern.

### Concrete Deliverables
- All NanoClaw source files merged: `src/`, `container/`, `groups/`, `CLAUDE.md`, `package.json`
- `groups/pocketclaw/CLAUDE.md` (PRD §7.2 directives)
- `src/channels/telegram/` (via /add-telegram skill)
- `src/channels/whatsapp/` (via /add-whatsapp skill)
- `src/modules/debouncer.ts` + test
- `src/modules/photo-processor.ts` + test
- `src/modules/ingestion/google.ts`, `microsoft.ts`, `apple.ts`, `file-watcher.ts`, `scheduler.ts`
- `src/modules/wiki-generator.ts`
- `groups/pocketclaw/skills/` — all 9 slash commands
- `docker-compose.yml` extended with PocketClaw volumes
- `.env` extended with all PRD Appendix B vars
- `vitest` tests for all new modules
- `docs/SETUP.md`, `docs/OBSIDIAN_SETUP.md`

### Definition of Done
- [ ] `pnpm install && pnpm build` exits 0
- [ ] `pnpm test` — all vitest tests pass
- [ ] `docker compose up -d` → container starts
- [ ] `docker exec pocketclaw whoami` → `user` (non-root)
- [ ] Telegram bot responds to `/start`
- [ ] `/memory test fact` → `mnemon remember "test fact"` stored
- [ ] Photo sent to Telegram → description in Mnemon, photo deleted from cache
- [ ] Same message within 5s on Telegram + WhatsApp → single batched prompt

### Must Have
- NanoClaw conventions followed exactly (TypeScript, pnpm, vitest, groups/ pattern)
- Non-root container (uid 1000), cap_drop ALL, read-only rootfs
- `.env` never committed — in `.gitignore`
- Only assembled prompts leave the machine
- Stickers silently ignored — zero processing
- Photos deleted from cache after processing
- SHA256 idempotency for file ingestion
- All tool calls to `/tmp/audit.log`
- Conventional Commits for every commit (existing pre-commit hook enforced)

### Must NOT Have
- No parallel Python implementation of NanoClaw modules (TypeScript only)
- No Docker socket mounted inside container
- No `--privileged` flag in compose
- No raw emails/messages in Anthropic API calls
- No video processing (ignore + error message)
- No sticker responses
- No multi-user logic
- No `:latest` Docker tags

---

## Verification Strategy

### Test Decision
- **Infrastructure**: vitest already in NanoClaw (carried over in T1)
- **Pattern**: Tests in same directory as source — `src/modules/debouncer.ts` → `src/modules/debouncer.test.ts`
- **Framework**: vitest (TypeScript, matches NanoClaw convention)
- **Agent-Executed QA**: ALWAYS for every task

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 0 (FIRST — must complete before anything else):
└── T0:  Install git hooks + verify branch name                             [quick]

Wave 1 (After T0 — foundations, parallel):
├── T1:  Complete NanoClaw merge (nanoclaw-v2 partial + fetch missing files) [unspecified-high]
├── T2:  PocketClaw agent group scaffold (groups/pocketclaw/)               [quick]
├── T3:  .env + docker-compose PocketClaw extensions                        [quick]
└── T4:  Read NanoClaw CLAUDE.md + extend for PocketClaw                   [quick]

Wave 2 (After T1 complete — skills + core modules, parallel):
├── T5:  Install /add-telegram skill                           [unspecified-high]
├── T6:  Install /add-whatsapp skill                          [unspecified-high]
└── T7:  MessageDebouncer module (src/modules/debouncer.ts)   [unspecified-high]

Wave 3 (After Wave 2 — ingestion + photo, parallel):
├── T8:  Photo processing (src/modules/photo-processor.ts)    [unspecified-high]
├── T9:  Google ingestion (src/modules/ingestion/google.ts)   [unspecified-high]
├── T10: Microsoft ingestion (src/modules/ingestion/microsoft.ts) [unspecified-high]
└── T11: Apple ingestion (src/modules/ingestion/apple.ts)     [unspecified-high]

Wave 4 (After Wave 3 — scheduler + wiki + skills, parallel):
├── T12: File auto-discovery (src/modules/ingestion/file-watcher.ts) [unspecified-high]
├── T13: Cloud scheduler (src/modules/ingestion/scheduler.ts)        [quick]
├── T14: LLM Wiki generator (src/modules/wiki-generator.ts)          [unspecified-high]
└── T15: PocketClaw slash commands (groups/pocketclaw/skills/)        [unspecified-high]

Wave 5 (After Wave 4 — wiring + tests + docs, parallel):
├── T16: Harness wiring + morning digest cron (groups/pocketclaw/config) [deep]
├── T17: Vitest tests for debouncer + photo                             [unspecified-high]
├── T18: Vitest tests for ingestion modules                             [unspecified-high]
└── T19: Documentation (README, docs/SETUP.md, docs/OBSIDIAN_SETUP.md) [writing]

Wave FINAL (after ALL — 4 parallel reviews then user okay):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real manual QA (unspecified-high)
└── F4: Scope fidelity check (deep)
→ Present results → Get explicit user okay
```

### Dependency Matrix
- **T1**: none → blocks T2-T19
- **T2,T3,T4**: T1 → blocks T5-T16
- **T5,T6**: T1,T2 → blocks T16
- **T7**: T1 → blocks T16,T17
- **T8**: T1,T7 → blocks T16,T17
- **T9,T10,T11**: T1 → blocks T13,T16,T18
- **T12**: T1 → blocks T13,T16,T18
- **T13**: T9,T10,T11,T12 → blocks T16
- **T14**: T1,T7 → blocks T15,T16
- **T15**: T2,T14 → blocks T16
- **T16**: T5,T6,T7,T8,T13,T14,T15 → F1-F4
- **T17,T18**: T7,T8,T9-T12 → F1-F4
- **T19**: T16 → F1-F4

---

## TODOs

---

- [x] 0. Install git hooks + verify conventions

  **What to do**:
  - Install git hooks by running the repo's setup script:
    ```powershell
    # Windows (PowerShell)
    ./scripts/setup_hooks.ps1
    ```
    ```bash
    # macOS/Linux
    ./scripts/setup_hooks.sh
    ```
  - Verify hooks installed: confirm `.git/hooks/commit-msg` and `.git/hooks/pre-push` exist
  - Verify current branch name is valid: `git rev-parse --abbrev-ref HEAD` → must match
    `^(feature|fix|bugfix|hotfix|chore)/.+$` — current branch is `feature/pocketclaw-build` ✅
  - Confirm commit message convention is understood by running a dry-run:
    `echo "feat: test" | npx commitlint` → should pass
  - Check `nanoclaw-v2/` directory exists (partial NanoClaw already in repo from previous commits)
    and document what's missing: `src/`, `groups/`, `package.json`, `pnpm-lock.yaml`,
    `tsconfig.json`, `vitest.config.ts`, `nanoclaw.sh`, `setup.sh`

  **Must NOT do**:
  - Do not skip this task — hooks MUST be installed before T1 commits or they won't be enforced
  - Do not rename the branch — `feature/pocketclaw-build` is correct

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — must complete before T1 (hooks must be active before commits)
  - **Blocked By**: None
  - **Blocks**: ALL tasks (hooks must be active)

  **References**:
  - `.githooks/commit-msg` — commit format regex: `^(feat|fix|docs|style|refactor|test|chore|perf|ci|build)(\(.+\))?: .{1,50}`
  - `.githooks/pre-push` — branch naming regex: `^(main|master|develop|development|staging|chore/.+|release\/...|feature\/.+|fix\/.+|bugfix\/.+|hotfix\/.+)$`
  - `CONTRIBUTING.md` — full commit and branching conventions
  - `scripts/setup_hooks.ps1` — Windows hook installer
  - `scripts/setup_hooks.sh` — macOS/Linux hook installer

  **Acceptance Criteria**:
  - [ ] `.git/hooks/commit-msg` exists and is executable
  - [ ] `.git/hooks/pre-push` exists and is executable
  - [ ] `git rev-parse --abbrev-ref HEAD` → `feature/pocketclaw-build`
  - [ ] `echo "feat: test message" | npx commitlint` → exits 0
  - [ ] `echo "WIP: bad message" | npx commitlint` → exits non-zero

  **QA Scenarios**:
  ```
  Scenario: Hooks installed and enforcing conventions
    Tool: Bash
    Steps:
      1. Run: ls .git/hooks/commit-msg .git/hooks/pre-push && echo "hooks present"
      2. Run: echo "feat: valid commit" | npx commitlint && echo "valid"
      3. Run: echo "bad commit message" | npx commitlint 2>&1 | head -5
    Expected Result: Step 1 → "hooks present"; Step 2 → "valid"; Step 3 → error output
    Evidence: .omo/evidence/task-0-hooks.txt
  ```

  **Commit**: YES
  - Message: `chore: install git hooks and verify branch conventions`
  - Files: none (hooks are in .git/, not tracked)

---

- [~] 1. Complete NanoClaw merge into repo root

  **What to do**:
  - `nanoclaw-v2/` already exists in the repo (partial copy from commit `3bb9913`) but is
    incomplete — it has docs/assets only, missing `src/`, `groups/`, `package.json` etc.
  - Add NanoClaw as a remote and fetch, then copy MISSING files only:
    ```bash
    git remote add nanoclaw https://github.com/nanocoai/nanoclaw.git
    git fetch nanoclaw
    # Copy everything NanoClaw has that isn't already at root:
    git checkout nanoclaw/main -- src/ container/ groups/ package.json \
      pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts \
      vitest.skills.config.ts eslint.config.js .npmrc .nvmrc .prettierrc \
      nanoclaw.sh setup.sh CLAUDE.md
    ```
  - **scripts/ collision**: DO NOT copy NanoClaw's `scripts/` over pocketclaw's `scripts/*.py`.
    Instead inspect first, then copy only non-conflicting NanoClaw scripts to `scripts/nanoclaw/`:
    ```bash
    git show nanoclaw/main:scripts/ | head -30   # inspect what NanoClaw has
    mkdir -p scripts/nanoclaw
    # copy each non-conflicting file individually
    git remote remove nanoclaw
    ```
  - Also move `nanoclaw-v2/` contents to root where missing, then delete `nanoclaw-v2/`:
    ```bash
    # copy any unique files from nanoclaw-v2/ that aren't already at root
    # then: git rm -r nanoclaw-v2/
    ```
  - Merge `.gitignore`: append NanoClaw's gitignore rules to existing pocketclaw `.gitignore`
    (keep both — do not replace)
  - Run `pnpm install` then `pnpm build` — confirm exits 0
  - Run `pnpm test` — confirm baseline NanoClaw tests pass
  - Merge `.gitignore`: append NanoClaw's ignore rules to existing pocketclaw `.gitignore`
    (keep both sets — do not replace). Run `git checkout nanoclaw/main -- .gitignore` then
    re-append any pocketclaw-specific ignores that got removed.
  - Run `pnpm install`
  - Run `pnpm build` — confirm exits 0
  - Run `pnpm test` — confirm existing NanoClaw tests pass before any customization
  - Remove NanoClaw remote after copy: `git remote remove nanoclaw`

  **Must NOT do**:
  - Do not `git merge nanoclaw/main` (history conflict with pocketclaw template)
  - Do not delete pocketclaw's existing `docs/`, `tests/`, `scripts/*.py`, `pyproject.toml`,
    `app/` directories — keep them alongside NanoClaw files
  - Do not commit credentials

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1, but T2-T4 should wait for T1 to confirm build passes)
  - **Parallel Group**: Wave 1 — start T2, T3, T4 immediately, but they must wait for T1's
    pnpm build to confirm before writing into NanoClaw files
  - **Blocks**: ALL other tasks
  - **Blocked By**: None

  **References**:
  - `https://github.com/nanocoai/nanoclaw` — source repo
  - `nanocoai/nanoclaw:README.md` — architecture overview
  - `nanocoai/nanoclaw:src/` — TypeScript source to copy
  - `nanocoai/nanoclaw:groups/` — groups/global and groups/main to copy as templates

  **Acceptance Criteria**:
  - [ ] `src/index.ts` exists in pocketclaw repo
  - [ ] `groups/global/` and `groups/main/` exist
  - [ ] `pnpm install` exits 0
  - [ ] `pnpm build` exits 0
  - [ ] `pnpm test` exits 0 (all NanoClaw baseline tests pass)
  - [ ] `git remote` does NOT list `nanoclaw` (cleaned up)

  **QA Scenarios**:
  ```
  Scenario: Build succeeds after NanoClaw merge
    Tool: Bash
    Steps:
      1. Run: pnpm build 2>&1 | tail -10
    Expected Result: Exit 0, "build" or "done" in output, no TypeScript errors
    Evidence: .omo/evidence/task-1-build.txt

  Scenario: Tests pass
    Tool: Bash
    Steps:
      1. Run: pnpm test 2>&1 | tail -20
    Expected Result: All vitest tests pass, 0 failures
    Evidence: .omo/evidence/task-1-tests.txt
  ```

  **Commit**: YES
  - Message: `feat(nanoclaw): merge nanoclaw base into pocketclaw`
  - Files: `src/**`, `container/**`, `groups/**`, `CLAUDE.md`, `package.json`, `pnpm-lock.yaml`,
    `tsconfig.json`, `vitest.config.ts`, `.npmrc`, `.prettierrc`, `nanoclaw.sh`, `setup.sh`

---

- [x] 2. PocketClaw agent group scaffold

  **What to do**:
  - Create `groups/pocketclaw/` directory (alongside existing `groups/global/` and `groups/main/`)
  - Read `groups/main/` structure to understand the convention, then mirror it for pocketclaw:
    - `groups/pocketclaw/CLAUDE.md` — full content from PRD §7.2 (verbatim + append to any
      NanoClaw base directives found in groups/main/CLAUDE.md)
    - `groups/pocketclaw/skills/` — empty dir (skills added in T15)
    - `groups/pocketclaw/config.json` — agent group config matching NanoClaw's schema
      (read `groups/main/config.json` as template; update name, description)
  - The CLAUDE.md must contain ALL sections from PRD §7.2:
    Identity, Purpose, Memory Protocol, Tool Use Policy, Response Style,
    Emotional Awareness, Permissions, Boundaries, Batched Message Handling, Photo Handling

  **Must NOT do**:
  - Do not modify `groups/global/` or `groups/main/` — create new group only
  - Do not invent a config.json schema — read groups/main/ first

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1, after T1 pnpm build confirms)
  - **Blocks**: T5, T6, T15, T16
  - **Blocked By**: T1

  **References**:
  - `groups/main/` — structure template (read first)
  - `groups/global/` — global directives to understand inheritance
  - `PRD.md §7.2` — full CLAUDE.md text to place in groups/pocketclaw/CLAUDE.md
  - `nanocoai/nanoclaw:src/group-init.ts` — how groups are initialized (read for schema)

  **Acceptance Criteria**:
  - [ ] `groups/pocketclaw/CLAUDE.md` exists with all 10 PRD §7.2 sections
  - [ ] `groups/pocketclaw/config.json` exists and is valid JSON
  - [ ] `groups/pocketclaw/skills/` directory exists
  - [ ] CLAUDE.md contains "PocketClaw" as identity (not "Claude")
  - [ ] CLAUDE.md contains sticker directive "Stickers are silently ignored"

  **QA Scenarios**:
  ```
  Scenario: All CLAUDE.md sections present
    Tool: Bash
    Steps:
      1. Run: node -e "const c=require('fs').readFileSync('groups/pocketclaw/CLAUDE.md','utf8'); const s=['Identity','Purpose','Memory Protocol','Batched Message Handling','Photo Handling']; s.forEach(x=>console.log(x, c.includes(x)))"
    Expected Result: All sections print true
    Evidence: .omo/evidence/task-2-claudemd.txt

  Scenario: config.json valid JSON
    Tool: Bash
    Steps:
      1. Run: node -e "JSON.parse(require('fs').readFileSync('groups/pocketclaw/config.json','utf8')); console.log('valid')"
    Expected Result: "valid"
    Evidence: .omo/evidence/task-2-config.txt
  ```

  **Commit**: YES (group with T3, T4)
  - Message: `feat(group): create pocketclaw agent group with CLAUDE.md directives`
  - Files: `groups/pocketclaw/CLAUDE.md`, `groups/pocketclaw/config.json`, `groups/pocketclaw/skills/.gitkeep`

---

- [x] 3. .env extension + docker-compose PocketClaw volumes

  **What to do**:
  - Extend NanoClaw's `.env.example` (copied in T1) with all PocketClaw-specific vars from
    PRD Appendix B. Do NOT replace existing NanoClaw vars — append a `# PocketClaw vars` section:
    ```env
    # PocketClaw vars
    TELEGRAM_ALLOWED_CHAT_ID=
    VAULT_PATH=~/.pocketclaw/vault
    MNEMON_DB_PATH=~/.pocketclaw/mnemon.db
    WATCH_PATHS_ROOT=~/.pocketclaw/watch
    LOG_PATH=~/.pocketclaw/logs
    VISION_MODEL=llava
    OLLAMA_EMBED_MODEL=nomic-embed-text
    GPU_ENABLED=false
    BATCH_WINDOW_MS=5000
    CONTAINER_MEMORY_LIMIT=2g
    GOOGLE_CLIENT_ID=
    GOOGLE_CLIENT_SECRET=
    MS_CLIENT_ID=
    APPLE_ID_EMAIL=
    APPLE_APP_PASSWORD=
    ```
  - Add to `.gitignore` (append, don't replace): `.env`, `secrets/`, `wa-session/`, `*.wa-session`,
    `vault/`, `logs/`, `.photo-cache/`
  - Create (or extend) `docker-compose.yml` using PRD §7.1 as spec, but extending any existing
    NanoClaw compose file rather than replacing it. Add:
    - `volumes:` section: `wa-session`, `photo-cache`
    - Security options: `user: "1000:1000"`, `cap_drop: [ALL]`, `read_only: true`,
      `no-new-privileges: true`, `tmpfs: [/tmp:size=100m,noexec]`
    - Volume mounts: `VAULT_PATH:/vault:rw`, `MNEMON_DB_PATH:/home/user/.mnemon:rw`,
      `WATCH_PATHS_ROOT:/watch:ro`, `wa-session:/home/user/.wa-session:rw`,
      `photo-cache:/home/user/.photo-cache:rw`
    - Environment variables from .env
    - `extra_hosts: host.docker.internal:host-gateway`
  - Create `config/mount-allowlist.json` per PRD §7.1

  **Must NOT do**:
  - Do not delete NanoClaw's existing docker-compose vars/services
  - Do not commit `.env`

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`docker-expert`]

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1, after T1)
  - **Blocks**: T16 (harness needs compose)
  - **Blocked By**: T1

  **References**:
  - `PRD.md §7.1` — docker-compose.yml full spec
  - `PRD.md §9.2` — security hardening checklist
  - `PRD.md Appendix B` — full env var list
  - `PRD.md §9.3` — secrets list

  **Acceptance Criteria**:
  - [ ] `.env.example` has all PRD Appendix B vars (≥15 PocketClaw-specific vars)
  - [ ] `.gitignore` contains `.env`, `secrets/`, `wa-session/`
  - [ ] `docker compose config --quiet` exits 0
  - [ ] `docker-compose.yml` contains `cap_drop`, `read_only: true`, `no-new-privileges`
  - [ ] `config/mount-allowlist.json` exists with allowed_write, allowed_read, denied keys

  **QA Scenarios**:
  ```
  Scenario: compose file is valid with security options
    Tool: Bash
    Steps:
      1. Run: docker compose config --quiet && echo "valid"
      2. Run: grep -c "cap_drop" docker-compose.yml
    Expected Result: "valid"; cap_drop count >= 1
    Evidence: .omo/evidence/task-3-compose.txt

  Scenario: .env not tracked
    Tool: Bash
    Steps:
      1. Run: git check-ignore -v .env 2>&1
    Expected Result: Output references .gitignore rule for .env
    Evidence: .omo/evidence/task-3-gitignore.txt
  ```

  **Commit**: YES (group with T2, T4)
  - Message: `feat(config): extend env template and docker-compose for PocketClaw`
  - Files: `.env.example`, `.gitignore`, `docker-compose.yml`, `config/mount-allowlist.json`

---

- [x] 4. Read and extend NanoClaw's root CLAUDE.md

  **What to do**:
  - Read the NanoClaw `CLAUDE.md` that was copied in T1 (it's at repo root, 24KB)
  - Append a `## PocketClaw` section at the bottom with:
    - Note that the pocketclaw agent group is at `groups/pocketclaw/`
    - PocketClaw-specific dev commands: how to add/test skills, how debouncer works
    - Link to `groups/pocketclaw/CLAUDE.md` for agent directives
    - Do NOT duplicate the full PRD §7.2 content here — just reference it

  **Must NOT do**:
  - Do not modify or overwrite NanoClaw's existing CLAUDE.md content
  - Append only — preserve all existing NanoClaw developer instructions

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1, after T1)
  - **Blocks**: T5, T6
  - **Blocked By**: T1

  **References**:
  - `CLAUDE.md` (after T1 merge) — existing NanoClaw content to preserve
  - `PRD.md §7.2` — what goes in groups/pocketclaw/CLAUDE.md (just reference, don't copy)

  **Acceptance Criteria**:
  - [ ] `CLAUDE.md` still contains NanoClaw's existing content (not replaced)
  - [ ] `CLAUDE.md` has new `## PocketClaw` section at bottom
  - [ ] Section references `groups/pocketclaw/` path

  **QA Scenarios**:
  ```
  Scenario: CLAUDE.md retains NanoClaw content and adds PocketClaw section
    Tool: Bash
    Steps:
      1. Run: grep -c "PocketClaw" CLAUDE.md && grep -c "groups/pocketclaw" CLAUDE.md
    Expected Result: Both counts >= 1
    Evidence: .omo/evidence/task-4-claudemd.txt
  ```

  **Commit**: YES (group with T2, T3)
  - Message: `docs(claude-md): append PocketClaw section to root CLAUDE.md`
  - Files: `CLAUDE.md`

---

- [x] 5. Install Telegram channel adapter via /add-telegram skill

  **What to do**:
  - Fetch the skill files from the `channels` branch of nanoclaw OR from the dedicated repo:
    ```bash
    # Step 1: inspect the nanoclaw-telegram repo structure first
    git remote add nanoclaw-telegram https://github.com/nanocoai/nanoclaw-telegram.git
    git fetch nanoclaw-telegram
    git ls-tree -r nanoclaw-telegram/main --name-only | head -40   # see what's there
    ```
  - Based on the tree output, copy the channel adapter files into `src/channels/telegram/`.
    The exact paths will be visible from the ls-tree output — do NOT assume a path without
    checking first. Likely candidates: `src/channels/telegram/` or `telegram/` at root.
    ```bash
    # After confirming paths:
    git checkout nanoclaw-telegram/main -- <confirmed-path>
    # Move to src/channels/telegram/ if not already there
    git remote remove nanoclaw-telegram
    ```
  - After copying the adapter files, wire the Telegram adapter into NanoClaw's channel registry
    following the pattern in `src/channels/` (read existing channel adapters for the pattern)
  - Configure: `TELEGRAM_BOT_TOKEN` from .env, `TELEGRAM_ALLOWED_CHAT_ID` allowlist (silent
    reject unknown senders)
  - Polling mode only — no webhook

  **Must NOT do**:
  - No webhook setup
  - No sticker responses — ensure sticker handling is silent drop
  - Do not hardcode bot token

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2, with T6 and T7)
  - **Blocks**: T16
  - **Blocked By**: T1, T2

  **References**:
  - `https://github.com/nanocoai/nanoclaw-telegram` — Telegram skill source
  - `src/channels/` (after T1) — existing channel adapter pattern to follow
  - `PRD.md §7.6` — Telegram spec: long polling, chat ID allowlist, photo routing, sticker drop
  - `PRD.md §8.5` — sticker handling (silently ignore)

  **Acceptance Criteria**:
  - [ ] `src/channels/telegram/` exists with handler files
  - [ ] Telegram adapter registered in channel registry
  - [ ] `pnpm build` exits 0 after adding Telegram files
  - [ ] Allowlist guard: unknown chat IDs silently rejected (verified via unit test or code review)
  - [ ] Sticker handler is a no-op (no response, no processing)

  **QA Scenarios**:
  ```
  Scenario: Telegram module builds without errors
    Tool: Bash
    Steps:
      1. Run: pnpm build 2>&1 | grep -i "telegram\|error" | head -20
    Expected Result: No TypeScript errors related to telegram module
    Evidence: .omo/evidence/task-5-telegram-build.txt

  Scenario: Sticker handling is no-op
    Tool: Bash
    Steps:
      1. Run: grep -r "sticker" src/channels/telegram/ --include="*.ts" -l
      2. Read each file and confirm sticker = early return, no response
    Expected Result: Sticker messages return early without enqueuing or responding
    Evidence: .omo/evidence/task-5-sticker.txt
  ```

  **Commit**: YES
  - Message: `feat(telegram): install telegram channel adapter`
  - Files: `src/channels/telegram/**`

---

- [x] 6. Install WhatsApp channel adapter via /add-whatsapp skill

  **What to do**:
  - Fetch WhatsApp/Baileys adapter from `nanocoai/nanoclaw-whatsapp`:
    ```bash
    git remote add nanoclaw-whatsapp https://github.com/nanocoai/nanoclaw-whatsapp.git
    git fetch nanoclaw-whatsapp
    git ls-tree -r nanoclaw-whatsapp/main --name-only | head -40   # inspect structure first
    # Then copy confirmed paths — do NOT assume src/channels/whatsapp/ without checking
    git checkout nanoclaw-whatsapp/main -- <confirmed-path>
    git remote remove nanoclaw-whatsapp
    ```
  - Wire into NanoClaw's channel registry
  - Persistent named volume for WhatsApp session (`wa-session`) — already in docker-compose from T3
  - Self-chat model: only respond to messages from self (per PRD §7.7)
  - Session ID = E.164 phone number (e.g., `+6591234567`)
  - Sticker handling: silent drop (same as Telegram)

  **Must NOT do**:
  - No inbound port — outbound WebSocket only
  - Do not store session in git — `wa-session/` is gitignored

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2, with T5, T7)
  - **Blocks**: T16
  - **Blocked By**: T1, T2

  **References**:
  - `https://github.com/nanocoai/nanoclaw-whatsapp` — WhatsApp skill source
  - `src/channels/` (after T1) — existing channel adapter pattern
  - `PRD.md §7.7` — WhatsApp spec: Baileys, self-chat model, QR session, named volume

  **Acceptance Criteria**:
  - [ ] `src/channels/whatsapp/` exists
  - [ ] WhatsApp adapter registered in channel registry
  - [ ] `pnpm build` exits 0
  - [ ] Session stored to `wa-session` named volume (not host filesystem)
  - [ ] Sticker handler is no-op

  **QA Scenarios**:
  ```
  Scenario: WhatsApp module builds
    Tool: Bash
    Steps:
      1. Run: pnpm build 2>&1 | grep -i "whatsapp\|error" | head -20
    Expected Result: No TypeScript errors for whatsapp module
    Evidence: .omo/evidence/task-6-whatsapp-build.txt
  ```

  **Commit**: YES
  - Message: `feat(whatsapp): install whatsapp/baileys channel adapter`
  - Files: `src/channels/whatsapp/**`

---

- [x] 7. MessageDebouncer — unified 5s batch queue

  **What to do**:
  - Create `src/modules/debouncer.ts` — TypeScript implementation of PRD §7.5 logic:
    - `MessageType` enum: TEXT, PHOTO, STICKER
    - `QueuedMessage` interface: platform, timestamp, messageId, text, messageType, attachmentPath?
    - `MessageDebouncer` class:
      - Per-session queues (`Map<string, QueuedMessage[]>`)
      - Per-session timers (`Map<string, NodeJS.Timeout>`)
      - `push(sessionId: string, message: QueuedMessage): void`
        - Silently drop if `messageType === MessageType.STICKER` (early return)
        - Append to queue, reset timer to `BATCH_WINDOW_MS` (default 5000)
      - `_flush(sessionId: string): void` — collect queue, call `onBatch` callback
    - `formatBatchPrompt(messages: QueuedMessage[]): string`
      — wraps in `[BATCH START — N messages]` / `[BATCH END]`, tags photos
  - Create `src/modules/debouncer.test.ts` — vitest tests from PRD §11.1:
    - 3 messages within 5s → 1 batch
    - 2 messages 6s apart → 2 batches
    - Sticker → silently ignored, no batch fired
    - Cross-platform same session → batched together

  **Must NOT do**:
  - No Claude Code calls inside debouncer — it only collects and formats
  - No sticker content logged

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2, with T5, T6)
  - **Blocks**: T8, T16, T17
  - **Blocked By**: T1

  **References**:
  - `PRD.md §7.5` — full debouncer design + Python pseudocode to translate to TypeScript
  - `PRD.md §11.1` — unit tests to implement (translate from pytest to vitest)
  - `src/types.ts` (from T1 NanoClaw merge) — existing types to extend from

  **Acceptance Criteria**:
  - [ ] `src/modules/debouncer.ts` compiles without errors
  - [ ] `src/modules/debouncer.test.ts` — all 4 vitest tests pass
  - [ ] `pnpm test` exits 0

  **QA Scenarios**:
  ```
  Scenario: 3 messages within window → 1 batch
    Tool: Bash
    Steps:
      1. Run: pnpm test src/modules/debouncer.test.ts 2>&1 | tail -15
    Expected Result: 4 passing tests, 0 failing
    Evidence: .omo/evidence/task-7-debouncer-tests.txt

  Scenario: Sticker drops silently
    Tool: Bash
    Steps:
      1. Run: pnpm test src/modules/debouncer.test.ts --reporter=verbose 2>&1 | grep -i sticker
    Expected Result: "sticker" test passes
    Evidence: .omo/evidence/task-7-sticker-drop.txt
  ```

  **Commit**: YES
  - Message: `feat(queue): add MessageDebouncer with 5s batch window and sticker drop`
  - Files: `src/modules/debouncer.ts`, `src/modules/debouncer.test.ts`

---

- [x] 8. Photo processing pipeline

  **What to do**:
  - Create `src/modules/photo-processor.ts`:
    - `validatePhoto(filePath: string): { valid: boolean; error?: string }`:
      check MIME type (jpeg/png/webp only), size < 10MB
    - `resizePhoto(filePath: string, maxPx: number = 2048): Promise<string>`: resize longest
      edge to maxPx preserving aspect ratio (use `sharp` npm package)
    - `generateDescription(imagePath: string, userMessage: string, platform: string): Promise<string>`:
      call Ollama vision API (llava model) with prompt from PRD §7.8
    - `processPhoto(attachment: PhotoAttachment, userMessage: string, platform: string): Promise<string>`:
      full pipeline — download → validate → resize → describe → mnemon remember → delete cache → return description
    - Delete photo from `/home/user/.photo-cache/` immediately after processing
  - Add `sharp` to package.json dependencies
  - Create `src/modules/photo-processor.test.ts` — unit tests from PRD §11.1:
    - Valid formats accepted (jpeg/png/webp)
    - Invalid formats rejected (mp4, pdf, gif)
    - Size limit enforced (>10MB rejected)

  **Must NOT do**:
  - Do not store photos permanently — delete from cache after processing
  - Do not log raw photo bytes

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3, with T9-T11)
  - **Blocks**: T16, T17
  - **Blocked By**: T1, T7

  **References**:
  - `PRD.md §7.8` — full photo pipeline spec, validation rules, prompt template
  - `PRD.md §7.4` — Ollama vision model (llava) endpoint config
  - `PRD.md §10.2` — photo processing data flow diagram
  - `PRD.md §11.1` — photo processor unit tests to implement

  **Acceptance Criteria**:
  - [ ] `src/modules/photo-processor.ts` compiles
  - [ ] Photo validation tests pass: jpeg/png/webp → valid; mp4/pdf → invalid
  - [ ] Size limit test: >10MB → rejected
  - [ ] `pnpm build` exits 0

  **QA Scenarios**:
  ```
  Scenario: Photo validation unit tests pass
    Tool: Bash
    Steps:
      1. Run: pnpm test src/modules/photo-processor.test.ts 2>&1 | tail -15
    Expected Result: All tests pass, 0 failing
    Evidence: .omo/evidence/task-8-photo-tests.txt

  Scenario: Photo pipeline calls cleanup
    Tool: Bash
    Steps:
      1. Run: grep -n "unlink\|rm\|delete\|cleanup" src/modules/photo-processor.ts
    Expected Result: Cleanup call present in processPhoto function
    Evidence: .omo/evidence/task-8-photo-cleanup.txt
  ```

  **Commit**: YES
  - Message: `feat(photo): add photo processing pipeline with validation and cache cleanup`
  - Files: `src/modules/photo-processor.ts`, `src/modules/photo-processor.test.ts`, `package.json` (sharp dep)

---

- [x] 9. Google cloud ingestion (Gmail, Calendar, Contacts)

  **What to do**:
  - Install: `pnpm add googleapis @google-cloud/local-auth`
  - Create `src/modules/ingestion/google.ts`:
    - `GoogleAuthManager`: OAuth2 flow using `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`;
      saves token to `~/.pocketclaw/secrets/google_token.json`; auto-refresh
    - `GmailIngester.fetch(since: Date): Promise<Fact[]>`:
      pulls last 24h emails via Gmail API; extracts sender, recipients, subject, body (plain),
      date, thread_id; strips HTML; returns as facts array
    - `GoogleCalendarIngester.fetch(since: Date): Promise<Fact[]>`:
      pulls events; extracts title, attendees, start/end, location, description
    - `GoogleContactsIngester.fetch(): Promise<Fact[]>`:
      pulls contacts via People API; extracts name, emails, phones, company, job title
    - Each ingester: idempotent (pass through mnemon dedup); fault-isolated (throws on error,
      caller catches; other ingesters continue)
  - Scopes: `gmail.readonly`, `calendar.readonly`, `contacts.readonly`

  **Must NOT do**:
  - Never send raw email bodies to Anthropic API — extract facts first
  - Do not store credentials in code — all via env vars and secrets/ dir

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3, with T8, T10, T11)
  - **Blocks**: T13
  - **Blocked By**: T1

  **References**:
  - `PRD.md §7.9.1` — Google ingestion spec, OAuth2 setup, scopes, extracted fields
  - `PRD.md §9.1` — prompt injection risk from email content (strip HTML before mnemon)

  **Acceptance Criteria**:
  - [ ] `src/modules/ingestion/google.ts` compiles
  - [ ] `GoogleAuthManager` reads `GOOGLE_CLIENT_ID` from env (no hardcoded values)
  - [ ] Each ingester class has `fetch()` method returning `Promise<Fact[]>`
  - [ ] HTML stripping applied to email bodies before returning facts

  **QA Scenarios**:
  ```
  Scenario: Google module compiles and exports correct classes
    Tool: Bash
    Steps:
      1. Run: pnpm build 2>&1 | grep -i "google\|error" | head -10
      2. Run: node -e "const g = require('./dist/modules/ingestion/google.js'); console.log(typeof g.GmailIngester, typeof g.GoogleCalendarIngester)"
    Expected Result: Build clean; "function function"
    Evidence: .omo/evidence/task-9-google-build.txt
  ```

  **Commit**: YES (group with T10, T11)
  - Message: `feat(ingestion): add Google cloud ingestion (Gmail, Calendar, Contacts)`
  - Files: `src/modules/ingestion/google.ts`

---

- [x] 10. Microsoft cloud ingestion (Outlook Mail, Calendar, Contacts)

  **What to do**:
  - Install: `pnpm add @azure/msal-node @microsoft/microsoft-graph-client`
  - Create `src/modules/ingestion/microsoft.ts`:
    - `MicrosoftAuthManager`: MSAL device-code flow, `MS_CLIENT_ID` env var,
      token cached to `~/.pocketclaw/secrets/ms_token.json`
    - `OutlookMailIngester.fetch(since: Date): Promise<Fact[]>`:
      Graph API `/me/messages`; extract sender, recipients, subject, body (text), date, conversationId
    - `OutlookCalendarIngester.fetch(): Promise<Fact[]>`:
      `/me/calendarView`; extract subject, attendees, start/end, location, isRecurring
    - `OutlookContactsIngester.fetch(): Promise<Fact[]>`:
      `/me/contacts`; extract displayName, emails, phones, company, jobTitle
    - Fault-isolated per source

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3, with T8, T9, T11)
  - **Blocks**: T13
  - **Blocked By**: T1

  **References**:
  - `PRD.md §7.9.2` — Microsoft Graph spec, device code flow, extracted fields
  - `src/modules/ingestion/google.ts` (T9) — parallel pattern to follow

  **Acceptance Criteria**:
  - [ ] `src/modules/ingestion/microsoft.ts` compiles
  - [ ] `MicrosoftAuthManager` reads `MS_CLIENT_ID` from env
  - [ ] Each ingester has `fetch()` returning `Promise<Fact[]>`
  - [ ] `pnpm build` exits 0

  **QA Scenarios**:
  ```
  Scenario: Microsoft module compiles and exports classes
    Tool: Bash
    Steps:
      1. Run: pnpm build 2>&1 | grep -i "microsoft\|error" | head -10
    Expected Result: No TypeScript errors for microsoft module
    Evidence: .omo/evidence/task-10-microsoft-build.txt
  ```

  **Commit**: YES (group with T9, T11)
  - Message: `feat(ingestion): add Microsoft cloud ingestion (Mail, Calendar, Contacts)`
  - Files: `src/modules/ingestion/microsoft.ts`

---

- [x] 11. Apple cloud ingestion (IMAP, CalDAV, CardDAV)

  **What to do**:
  - Install: `pnpm add imap-simple tsdav`
  - Create `src/modules/ingestion/apple.ts`:
    - `AppleMailIngester.fetch(since: Date): Promise<Fact[]>`:
      IMAP to `imap.mail.me.com:993`, auth via `APPLE_ID_EMAIL` + `APPLE_APP_PASSWORD`,
      extract sender, recipients, subject, body (plain), date
    - `AppleCalendarIngester.fetch(): Promise<Fact[]>`:
      CalDAV to `https://caldav.icloud.com/`, same credentials;
      extract title, attendees, start/end, location, description
    - `AppleContactsIngester.fetch(): Promise<Fact[]>`:
      CardDAV to `https://contacts.icloud.com/`, same credentials;
      extract fullName, emails, phones, company, jobTitle
    - Note on Apple Principal ID: use `.well-known/carddav` redirect to discover principal URL;
      document this in a code comment with reference to PRD §16

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3, with T8, T9, T10)
  - **Blocks**: T13
  - **Blocked By**: T1

  **References**:
  - `PRD.md §7.9.3` — Apple IMAP/CalDAV/CardDAV spec, app-specific password
  - `PRD.md §16` — Apple Principal ID open item (discover via .well-known redirect)

  **Acceptance Criteria**:
  - [ ] `src/modules/ingestion/apple.ts` compiles
  - [ ] Uses `APPLE_ID_EMAIL` + `APPLE_APP_PASSWORD` env vars (no hardcoded creds)
  - [ ] Code comment documents Apple Principal ID discovery method
  - [ ] `pnpm build` exits 0

  **QA Scenarios**:
  ```
  Scenario: Apple module compiles
    Tool: Bash
    Steps:
      1. Run: pnpm build 2>&1 | grep -i "apple\|error" | head -10
    Expected Result: No TypeScript errors for apple module
    Evidence: .omo/evidence/task-11-apple-build.txt
  ```

  **Commit**: YES (group with T9, T10)
  - Message: `feat(ingestion): add Apple cloud ingestion (IMAP, CalDAV, CardDAV)`
  - Files: `src/modules/ingestion/apple.ts`

---

- [x] 12. File auto-discovery (watchdog + SHA256 idempotency)

  **What to do**:
  - Install: `pnpm add chokidar mammoth pptx-text-extract pdf-parse ical.js vcard-js`
  - Create `src/modules/ingestion/file-watcher.ts`:
    - `FileWatcher` class: uses `chokidar` to watch `WATCH_PATHS_ROOT` (recursive)
    - On `add`/`change` event: compute SHA256 of file; check against `processed.db` SQLite;
      skip if already processed with same hash
    - `extractText(filePath: string): Promise<string>` — dispatcher:
      `.md`/`.txt` → read file; `.docx` → mammoth; `.pptx` → pptx-text-extract;
      `.pdf` → pdf-parse; `.eml` → email stdlib (Node); `.vcf` → vcard-js; `.ics` → ical.js
    - After extraction: chunk (512 tokens, 64 overlap), call entity extraction per chunk,
      call `mnemon remember` for each fact, store SHA256 in processed.db
    - If >10 new entities: trigger wiki generation
    - Audit log entry for each processed file

  **Must NOT do**:
  - `/watch` is mounted read-only — never write to watch path
  - Do not process unsupported file types (log + skip)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 4, with T13, T14, T15)
  - **Blocks**: T13, T16
  - **Blocked By**: T1

  **References**:
  - `PRD.md §7.10` — file ingestion spec, supported formats, chunker, idempotency
  - `PRD.md §10.3` — file ingestion data flow

  **Acceptance Criteria**:
  - [ ] `src/modules/ingestion/file-watcher.ts` compiles
  - [ ] SHA256 idempotency: same file processed twice → processed.db checked, second run is no-op
  - [ ] All 7 file types have extractors (md, txt, docx, pptx, pdf, eml, vcf/ics)
  - [ ] `pnpm build` exits 0

  **QA Scenarios**:
  ```
  Scenario: Idempotency — same file skipped on second pass
    Tool: Bash
    Steps:
      1. Run: node -e "const {FileWatcher}=require('./dist/modules/ingestion/file-watcher.js'); const w=new FileWatcher(); console.log(typeof w.extractText)"
    Expected Result: "function"
    Evidence: .omo/evidence/task-12-filewatcher.txt
  ```

  **Commit**: YES
  - Message: `feat(ingestion): add file auto-discovery with SHA256 idempotency`
  - Files: `src/modules/ingestion/file-watcher.ts`, `package.json` (new deps)

---

- [x] 13. Cloud ingestion scheduler

  **What to do**:
  - Create `src/modules/ingestion/scheduler.ts`:
    - `CloudScheduler` class: runs all 9 ingesters (Google x3, Microsoft x3, Apple x3) in parallel
    - Per-source fault isolation: `Promise.allSettled` — one failure doesn't block others
    - Logs partial failures via audit log with retry schedule
    - `runAll(): Promise<IngestSummary>` — returns count of facts per source, errors per source
    - Scheduled run: daily at 02:00 local time via NanoClaw's existing scheduled task system
    - Manual trigger: wired to `/ingest` command in T15

  **Must NOT do**:
  - No `Promise.all` — use `Promise.allSettled` for fault isolation
  - Do not log raw email content

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 4, with T12, T14, T15)
  - **Blocks**: T16
  - **Blocked By**: T9, T10, T11

  **References**:
  - `PRD.md §7.9.4` — cloud scheduler spec with fault isolation pattern
  - `PRD.md §10.4` — cloud ingestion data flow

  **Acceptance Criteria**:
  - [ ] `src/modules/ingestion/scheduler.ts` compiles
  - [ ] Uses `Promise.allSettled` (not `Promise.all`)
  - [ ] Returns `IngestSummary` with per-source counts and errors

  **QA Scenarios**:
  ```
  Scenario: Scheduler exports runAll and handles partial failures
    Tool: Bash
    Steps:
      1. Run: pnpm build 2>&1 | grep -i "scheduler\|error" | head -10
    Expected Result: Builds clean
    Evidence: .omo/evidence/task-13-scheduler.txt
  ```

  **Commit**: YES (group with T12)
  - Message: `feat(ingestion): add cloud ingestion scheduler with fault isolation`
  - Files: `src/modules/ingestion/scheduler.ts`

---

- [x] 14. LLM Wiki generator

  **What to do**:
  - Create `src/modules/wiki-generator.ts`:
    - `WikiGenerator` class:
      - `generateEntry(entityName: string): Promise<void>`:
        1. `mnemon list --type entity` → get entity list
        2. `mnemon recall --query "{entityName}" --depth 3` → get graph context
        3. Build wiki generation prompt from PRD §7.11 (verbatim)
        4. Call Claude Code (via NanoClaw's provider abstraction) with prompt
        5. Write output to `${VAULT_PATH}/wiki/${sanitize(entityName)}.md`
           (overwrite if exists — wiki entries are regenerated, not appended)
      - `generateAll(entities: string[]): Promise<void>`: parallelized over entities
      - Scheduled: nightly at 03:00 (after cloud ingestion at 02:00)
      - Event-driven: called when ingestion produces >10 new entities
  - Output format: Obsidian-compatible Markdown with YAML frontmatter + [[WikiLink]] syntax
    per PRD §7.11 template (copy template verbatim)

  **Must NOT do**:
  - Do not hallucinate facts — only use mnemon recall output
  - Do not append to wiki files — always overwrite (regenerated nightly)
  - Do not write outside `/vault/wiki/`

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 4, with T12, T13, T15)
  - **Blocks**: T16
  - **Blocked By**: T1, T7

  **References**:
  - `PRD.md §7.11` — wiki generator spec, prompt template (copy verbatim), example output
  - `PRD.md §10.5` — wiki generation data flow
  - `PRD.md §7.12` — vault directory structure (`vault/wiki/`)

  **Acceptance Criteria**:
  - [ ] `src/modules/wiki-generator.ts` compiles
  - [ ] Wiki generation prompt matches PRD §7.11 template (check key phrases)
  - [ ] Output path uses `VAULT_PATH` env var (not hardcoded)
  - [ ] YAML frontmatter in generated output includes `created`, `updated`, `entity_type`, `tags`

  **QA Scenarios**:
  ```
  Scenario: Wiki generator uses correct vault path
    Tool: Bash
    Steps:
      1. Run: grep -n "VAULT_PATH\|vault" src/modules/wiki-generator.ts | head -10
    Expected Result: VAULT_PATH referenced in output path construction
    Evidence: .omo/evidence/task-14-wiki-path.txt

  Scenario: Module compiles cleanly
    Tool: Bash
    Steps:
      1. Run: pnpm build 2>&1 | grep -i "wiki\|error" | head -10
    Expected Result: No TypeScript errors
    Evidence: .omo/evidence/task-14-wiki-build.txt
  ```

  **Commit**: YES
  - Message: `feat(wiki): add LLM wiki generator with Obsidian-compatible output`
  - Files: `src/modules/wiki-generator.ts`

---

- [x] 15. PocketClaw slash commands (groups/pocketclaw/skills/)

  **What to do**:
  - Create skill files in `groups/pocketclaw/skills/` — one `.md` file per command,
    following NanoClaw's skill file convention (read existing skills in `groups/main/skills/`
    or `.claude/commands/` to understand the format)
  - Commands to implement (per PRD §8.3):
    - `memory.md` — `/memory <fact>` → calls `mnemon remember`
    - `recall.md` — `/recall <query>` → calls `mnemon recall --query`
    - `wiki.md` — `/wiki <topic>` → calls wiki-generator for topic
    - `ingest.md` — `/ingest` → triggers CloudScheduler.runAll()
    - `status.md` — `/status` → mnemon entity count + last ingestion time
    - `digest.md` — `/digest` → trigger morning digest generation
    - `audit.md` — `/audit [date]` → read /tmp/audit.log filtered by date
    - `auth.md` — `/auth google|microsoft|apple` → start respective OAuth flow
    - `photo.md` — `/photo <description>` → manually store photo description in Mnemon
  - Each skill file should follow NanoClaw's pattern: description + instructions for Claude Code

  **Must NOT do**:
  - Do not implement business logic in skill files — skills call the modules from T9-T14
  - Do not create skills for sticker handling — stickers are silently ignored at the channel level

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 4, with T12, T13, T14)
  - **Blocks**: T16
  - **Blocked By**: T2 (needs groups/pocketclaw/ to exist), T14 (wiki skill needs generator)

  **References**:
  - `groups/main/skills/` (after T1) — existing skill file format to copy
  - `.claude/commands/` (after T1) — alternative skill location pattern
  - `PRD.md §8.3` — full command reference table

  **Acceptance Criteria**:
  - [ ] 9 skill files exist in `groups/pocketclaw/skills/`
  - [ ] Each file has at minimum: description + instructions
  - [ ] `/audit` skill references `/tmp/audit.log`
  - [ ] `/auth` skill has variants for google, microsoft, apple

  **QA Scenarios**:
  ```
  Scenario: All 9 skill files present
    Tool: Bash
    Steps:
      1. Run: ls groups/pocketclaw/skills/ | wc -l
    Expected Result: >= 9
    Evidence: .omo/evidence/task-15-skills.txt
  ```

  **Commit**: YES
  - Message: `feat(skills): add all PocketClaw slash command skills`
  - Files: `groups/pocketclaw/skills/*.md`

---

- [x] 16. Harness wiring + morning digest cron

  **What to do**:
  - Wire all PocketClaw modules into the pocketclaw agent group config:
    - Update `groups/pocketclaw/config.json` to reference:
      - Telegram channel adapter (`src/channels/telegram/`)
      - WhatsApp channel adapter (`src/channels/whatsapp/`)
      - Debouncer middleware (`src/modules/debouncer.ts`)
    - **SAFE router hook approach**: do NOT modify `src/router.ts` directly (would affect all
      agent groups). Instead, use NanoClaw's per-group middleware/hook mechanism if it exists.
      Read `src/router.ts` and `src/session-manager.ts` to find the correct extension point.
      Preferred approach: add a `groups/pocketclaw/hooks/pre-route.ts` if the hook system
      supports it, or register the debouncer as a channel-level middleware inside the Telegram
      and WhatsApp adapter files (T5/T6) rather than in the shared router. This keeps the
      debouncer scoped to the pocketclaw group only.
    - Photo attachment routing: both channel adapters route photos to `photo-processor.ts`
      before debouncing — this should be wired inside the channel adapter files, not the router
  - Add morning digest scheduled task:
    - Daily at 07:00 local time via NanoClaw's scheduled task system
    - Generates digest per PRD §8.2 (yesterday's emails, today's calendar, pending commitments)
    - Sends to Telegram (primary interface)
  - Add nightly cron jobs:
    - 02:00 — `CloudScheduler.runAll()`
    - 03:00 — `WikiGenerator.generateAll()` (triggered after ingestion)
  - Add startup: write `POCKETCLAW_START` entry to `/tmp/audit.log` on container boot

  **Must NOT do**:
  - Do not break existing NanoClaw routing for other groups (pocketclaw group only)
  - Do not hardcode chat IDs — use `TELEGRAM_ALLOWED_CHAT_ID` env var

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — must run after T5, T6, T7, T8, T13, T14, T15 all complete
  - **Parallel Group**: Wave 5 (sequential prerequisite for F1-F4)
  - **Blocks**: F1-F4
  - **Blocked By**: T5, T6, T7, T8, T13, T14, T15

  **References**:
  - `src/router.ts` (from T1) — routing hook points to add debouncer middleware
  - `src/host-sweep.ts` (from T1) — scheduled task pattern to follow for cron jobs
  - `PRD.md §7.5` — batch prompt format (debouncer already implemented in T7)
  - `PRD.md §8.2` — morning digest format
  - `PRD.md §10.1` — conversational query data flow (end-to-end)

  **Acceptance Criteria**:
  - [ ] `pnpm build` exits 0
  - [ ] `pnpm test` exits 0 (no regressions)
  - [ ] `groups/pocketclaw/config.json` references telegram + whatsapp channels
  - [ ] Morning digest cron at 07:00 exists in scheduled tasks
  - [ ] Cloud ingestion cron at 02:00 exists
  - [ ] Wiki generation cron at 03:00 exists
  - [ ] Startup writes to `/tmp/audit.log`

  **QA Scenarios**:
  ```
  Scenario: Full build + test passes after wiring
    Tool: Bash
    Steps:
      1. Run: pnpm build && pnpm test 2>&1 | tail -20
    Expected Result: Build exits 0, all tests pass
    Evidence: .omo/evidence/task-16-wiring-build.txt

  Scenario: Container starts non-root with read-only fs
    Tool: Bash (requires Docker)
    Steps:
      1. Run: docker compose up -d && sleep 5
      2. Run: docker exec pocketclaw whoami
      3. Run: docker exec pocketclaw touch /test_file 2>&1
    Expected Result: Step 2 → "user"; Step 3 → permission denied
    Evidence: .omo/evidence/task-16-container-security.txt
  ```

  **Commit**: YES
  - Message: `feat(harness): wire PocketClaw modules with cron jobs and audit log startup`
  - Files: `groups/pocketclaw/config.json`, any router/sweep modifications

---

- [~] 17. Vitest tests — debouncer + photo

  **What to do**:
  - All tests should already exist from T7 (`debouncer.test.ts`) and T8 (`photo-processor.test.ts`)
  - This task: run the full test suite, fix any failures, add missing edge case tests
  - Additional tests to add if not already present:
    - `debouncer.test.ts`: cross-platform batch (Telegram + WhatsApp same session)
    - `photo-processor.test.ts`: photo > 10MB rejected; WebP accepted; GIF rejected
    - `photo-processor.test.ts`: cleanup called even on processing failure
  - Run `pnpm test` and ensure 100% pass

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 5, with T18, T19)
  - **Blocks**: F1-F4
  - **Blocked By**: T7, T8

  **References**:
  - `PRD.md §11.1` — full unit test specs for debouncer and photo processor
  - `src/modules/debouncer.test.ts` (from T7)
  - `src/modules/photo-processor.test.ts` (from T8)

  **Acceptance Criteria**:
  - [ ] `pnpm test src/modules/debouncer.test.ts` → all pass
  - [ ] `pnpm test src/modules/photo-processor.test.ts` → all pass
  - [ ] Cross-platform batch test present and passing

  **QA Scenarios**:
  ```
  Scenario: All queue + photo tests pass
    Tool: Bash
    Steps:
      1. Run: pnpm test src/modules/debouncer.test.ts src/modules/photo-processor.test.ts 2>&1 | tail -20
    Expected Result: 0 failing tests
    Evidence: .omo/evidence/task-17-queue-photo-tests.txt
  ```

  **Commit**: YES (group with T18)
  - Message: `test(modules): complete debouncer and photo processor test suites`
  - Files: `src/modules/debouncer.test.ts`, `src/modules/photo-processor.test.ts`

---

- [~] 18. Vitest tests — ingestion modules

  **What to do**:
  - Create `src/modules/ingestion/file-watcher.test.ts`:
    - Idempotency: process same file twice → second call is no-op (mock SHA256 lookup)
    - Modified file (different SHA256) → re-ingested
    - Unsupported file type → skip + log
  - Create `src/modules/ingestion/scheduler.test.ts`:
    - One source throws → other sources still complete (Promise.allSettled)
    - Returns IngestSummary with per-source counts
  - Add guard tests for Telegram chat ID allowlist (if not already in T5 output):
    - `src/channels/telegram/guard.test.ts`: known ID → allowed; unknown ID → rejected

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 5, with T17, T19)
  - **Blocks**: F1-F4
  - **Blocked By**: T9-T13

  **References**:
  - `PRD.md §11.1` — mnemon idempotency tests + chat ID guard tests
  - `PRD.md §11.2` — integration test patterns to use as basis for unit mocks

  **Acceptance Criteria**:
  - [ ] `file-watcher.test.ts` — idempotency test passes
  - [ ] `scheduler.test.ts` — partial failure isolation test passes
  - [ ] `pnpm test` exits 0

  **QA Scenarios**:
  ```
  Scenario: All ingestion tests pass
    Tool: Bash
    Steps:
      1. Run: pnpm test src/modules/ingestion/ 2>&1 | tail -20
    Expected Result: 0 failing
    Evidence: .omo/evidence/task-18-ingestion-tests.txt
  ```

  **Commit**: YES (group with T17)
  - Message: `test(ingestion): add idempotency and fault isolation tests`
  - Files: `src/modules/ingestion/file-watcher.test.ts`, `src/modules/ingestion/scheduler.test.ts`

---

- [x] 19. Documentation

  **What to do**:
  - Update `README.md`: replace `[PROJECT TITLE]` with `PocketClaw — Personal AI Assistant`;
    add product overview paragraph; update Getting Started section with Docker setup steps
    (keep existing Python/uv section under a "Python Development" subsection)
  - Create `docs/SETUP.md`:
    - Full setup walkthrough: prerequisites (per PRD §12.1), clone, .env configuration,
      Docker startup, Telegram bot creation (@BotFather), cloud OAuth setup
    - Windows WSL2 notes (per PRD §12.2)
    - Mnemon + Ollama setup steps
  - Create `docs/OBSIDIAN_SETUP.md`:
    - Vault path configuration, Obsidian plugin list (Dataview, Graph View, Calendar, Tag Wrangler)
    - Syncthing setup (install, add vault folder, share with devices)
  - Create `docs/ARCHITECTURE.md`:
    - Architecture diagram from PRD §6 (ASCII art preserved)
    - Component descriptions (NanoClaw, Mnemon, Ollama, Syncthing roles)
    - Data flows from PRD §10

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: [`crafting-effective-readmes`]

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 5, with T16, T17, T18)
  - **Blocks**: F1-F4
  - **Blocked By**: T16

  **References**:
  - `README.md` — existing template to update (not replace)
  - `PRD.md §6` — architecture diagram
  - `PRD.md §10` — data flows
  - `PRD.md §12` — cross-platform prerequisites
  - `PRD.md §7.12` — Obsidian vault structure + Syncthing

  **Acceptance Criteria**:
  - [ ] `README.md` no longer has `[PROJECT TITLE]` placeholder
  - [ ] `docs/SETUP.md` exists with Telegram setup section
  - [ ] `docs/OBSIDIAN_SETUP.md` exists with Syncthing section
  - [ ] `docs/ARCHITECTURE.md` exists with ASCII architecture diagram

  **QA Scenarios**:
  ```
  Scenario: No placeholders remain in README
    Tool: Bash
    Steps:
      1. Run: grep -c "\[PROJECT TITLE\]" README.md
    Expected Result: 0
    Evidence: .omo/evidence/task-19-readme.txt
  ```

  **Commit**: YES
  - Message: `docs: add setup, architecture, and Obsidian guides`
  - Files: `README.md`, `docs/SETUP.md`, `docs/OBSIDIAN_SETUP.md`, `docs/ARCHITECTURE.md`

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Present results to user and get
> explicit "okay" before marking complete.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have":
  search codebase for forbidden patterns (Docker socket mount, `:latest` tags, hardcoded tokens,
  sticker responses, raw email in prompts). Check evidence files in `.omo/evidence/`. Compare
  deliverables list against what was built.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `pnpm build` + `pnpm test`. Review changed TypeScript files for: `as any`, empty catches,
  console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments,
  over-abstraction, generic names. Confirm pre-commit hooks pass on all changed files.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state (no existing .env). Follow `docs/SETUP.md` step-by-step. Execute every
  QA scenario from every task. Test cross-task integration: debouncer → Telegram → photo → mnemon
  → wiki all working together. Save evidence to `.omo/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual git diff. Verify 1:1 — everything in spec built,
  nothing beyond spec built. Check "Must NOT do" compliance. Flag any unaccounted changes.
  Output: `Tasks [N/N compliant] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit & Branch Conventions (MANDATORY — enforced by .githooks)

### Branch Naming (pre-push hook rejects non-compliant names)
- Pattern: `feature/xxx`, `fix/xxx`, `bugfix/xxx`, `hotfix/xxx`, `chore/xxx`, `release/yyyy-mm-dd`
- Current working branch: **`feature/pocketclaw-build`** ✅
- NEVER push directly to `main` or `staging` — hooks will warn; use PRs

### Commit Message Format (commit-msg hook enforces this)
- Format: `<type>[optional scope]: <short description>`
- Types allowed: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`
- Rules: lowercase, imperative mood ("add" not "added"), ≤72 chars total, no trailing period
- Scopes optional but allowed: `feat(queue): add debouncer`
- NO: `WIP:`, `TEMP:`, `TODO:`, `FIXME:` prefixes — hook rejects these
- Reference: `CONTRIBUTING.md §Issue Tracking & Commit Message Conventions`, `.githooks/commit-msg`

### Examples (valid)
```
feat: merge nanoclaw base into repo
feat(group): create pocketclaw agent group
feat(telegram): install telegram channel adapter
feat(whatsapp): install whatsapp baileys adapter
feat(queue): add message debouncer with 5s batch window
feat(photo): add photo processing pipeline
feat(ingestion): add Google cloud ingestion
feat(ingestion): add Microsoft cloud ingestion
feat(ingestion): add Apple cloud ingestion
feat(ingestion): add file auto-discovery with SHA256 idempotency
feat(wiki): add LLM wiki generator with Obsidian output
feat(skills): add all PocketClaw slash command skills
feat(harness): wire modules and add cron jobs
test: add debouncer and photo processor tests
test: add ingestion idempotency and fault isolation tests
docs: add setup, architecture and Obsidian guides
chore: install git hooks and verify conventions
```

### Commit Strategy per Wave
- T0: `chore: install git hooks and verify branch conventions`
- T1: `feat: complete nanoclaw merge — src groups container package.json`
- T2: `feat(group): create pocketclaw agent group with CLAUDE.md`
- T3: `feat(config): extend env template and docker-compose for PocketClaw`
- T4: `docs: extend root CLAUDE.md with PocketClaw section`
- T5: `feat(telegram): install telegram channel adapter`
- T6: `feat(whatsapp): install whatsapp baileys adapter`
- T7: `feat(queue): add message debouncer with 5s batch window`
- T8: `feat(photo): add photo processing pipeline`
- T9-T11 grouped: `feat(ingestion): add Google, Microsoft and Apple cloud ingesters`
- T12: `feat(ingestion): add file auto-discovery with SHA256 idempotency`
- T13: `feat(ingestion): add cloud ingestion scheduler`
- T14: `feat(wiki): add LLM wiki generator with Obsidian output`
- T15: `feat(skills): add all PocketClaw slash command skills`
- T16: `feat(harness): wire PocketClaw modules and add cron jobs`
- T17+T18 grouped: `test: add debouncer, photo and ingestion test suites`
- T19: `docs: add setup, architecture and Obsidian guides`

---

## Success Criteria

### Verification Commands
```bash
pnpm build          # Expected: exits 0
pnpm test           # Expected: all vitest tests pass
docker compose up -d && docker exec pocketclaw whoami   # Expected: "user"
docker exec pocketclaw touch /test_file                 # Expected: permission denied
```

### Final Checklist
- [ ] NanoClaw merged and building
- [ ] Telegram + WhatsApp channels installed and registered
- [ ] Debouncer active — cross-platform batching working
- [ ] Photo pipeline: validate → describe → store → delete
- [ ] Cloud ingestion: Google + Microsoft + Apple all wired
- [ ] File auto-discovery with SHA256 idempotency
- [ ] Wiki generator writing to vault/wiki/
- [ ] All cron jobs scheduled (02:00 ingest, 03:00 wiki, 07:00 digest)
- [ ] Container: non-root, read-only fs, audit log on startup
- [ ] All secrets via .env, nothing committed
- [ ] All vitest tests passing
- [ ] Documentation complete
