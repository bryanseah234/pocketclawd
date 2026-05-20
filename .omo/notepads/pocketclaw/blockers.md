# Blockers

## T1: NanoClaw merge — PARTIALLY blocked

### What's done
- NanoClaw v2 source merged into repo root (src/, groups/, container/, package.json, etc.)
- nanoclaw-v2/ directory removed
- pnpm install completed (285 packages, hoisted linker for exFAT)
- TypeScript build PASSES (`pnpm run build` → 556 dist/ files)
- All NanoClaw skills available at .claude/skills/ (add-telegram, add-whatsapp, add-mnemon, add-karpathy-llm-wiki, etc.)

### What's blocked
- `pnpm test` (vitest) → 142 tests fail because `better-sqlite3@11.10.0` native module
  fails to compile against Node v26.1.0
- `.nvmrc` requires Node 22; user has Node 26 installed globally
- `pnpm add better-sqlite3@latest` hangs past 5-min timeout (likely supply-chain
  minimumReleaseAge: 4320 blocking newer versions, or exFAT slowness)

### Resolution options (need user decision)
1. **Install Node 22** locally via `nvm-windows` or download from nodejs.org
   → matches .nvmrc, predictable, recommended by NanoClaw
2. **Upgrade better-sqlite3 to v12+** → supports Node 26 but requires editing
   pnpm-workspace.yaml supply-chain rules + manual lockfile update
3. **Skip tests for now** → accept that vitest won't run on this machine; rely on
   manual QA + production tests in CI

### Impact on remaining tasks
- T2-T16 (file scaffolding, skill installs, module writes) — NOT blocked,
  these don't require running tests
- T17, T18 (vitest tests for debouncer + ingestion) — BLOCKED until Node fix
- F1-F4 final review — partially blocked (can review code, can't run tests)

## Recommendation
Continue T2-T16 directly. Mark T17/T18 also as `[~]` blocked. User decides
Node 22 install vs better-sqlite3 upgrade later.
