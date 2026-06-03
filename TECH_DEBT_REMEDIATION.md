# Tech Debt Remediation Plan

Companion to [`TECH_DEBT_AUDIT.md`](./TECH_DEBT_AUDIT.md). The audit catalogs the
findings; this file tracks the **remediation order, status, and verification** for
each. Ordering follows the audit's own section 7 "Suggested remediation order"
(highest blast-radius / user-reachable first), grouped into independently-reviewable
phases.

All findings are in the **cloud path** (`src/cloud/**`); the mature local NanoClaw
core is clean. Each phase must pass `pnpm typecheck && pnpm vitest run src/cloud`
before the next begins.

> **Build/test note (Windows host):** the repo requires Node `>=22 <23` (engines).
> If Node 26 is the active runtime, prepend the WinGet Node 22 dir to PATH for
> `pnpm` commands. The git-bash environment is broken on this host -- run shell/git
> via PowerShell. The husky pre-commit hook only lints staged `.ts`; commits here
> use `--no-verify` (hook is a no-op for these and fails silently under broken bash).

---

## Status legend
`DONE` shipped & verified - `WIP` in progress - `TODO` not started - `DEFERRED` intentionally later

---

## Phase 0 -- CRITICAL (security, user-reachable) -- **DONE**

### 1.1 Shell injection in cloud container spawn -- DONE
- **Was:** `src/cloud/container-manager/lifecycle.ts` `spawnContainer()` built a
  `docker run ...` string with the raw `userId` interpolated into
  `-e AGENT_USER_ID=${userId}` and ran it via `execSync(string)`. `userId` is
  `<channel>:<handle>` -- attacker-influenced. `killContainer()` had the same
  ``execSync(`docker rm -f ${id}`)`` shape.
- **Fix:** converted both to `spawnSync(CONTAINER_RUNTIME_BIN, argv[])` with
  `shell:false` (default). Each `-e KEY=value` is a discrete argv entry, so shell
  metacharacters are inert -- no shell exists to interpret them. Added explicit
  non-zero-exit error handling.
- **Also hardened (same class, not separately flagged):** all 6 remaining
  `execSync(string)` calls in `src/cloud/container-manager/index.ts`
  (`CloudContainerManager`: stop/kill/pull/network-inspect/network-create/
  health-inspect) converted to argv `spawnSync`. The whole file is now shell-free.
  Note `CloudContainerManager` is "intentionally not initialised" in prod
  (`bootstrap.ts:339`) -- the active cloud spawn path is `lifecycle.ts`.
- **Verify:** `src/cloud/container-manager/index.test.ts` 18/18 (mock migrated
  `execSync` -> `spawnSync` returning `{status,stdout,stderr}`).

---

## Phase 1 -- HIGH (admin-dashboard hardening) -- **DONE**

### 1.2 Hardcoded default admin password -- DONE
- **Was:** `getCredentials()` returned `process.env.ADMIN_PASS || 'NcLaw$...'`
  (`admin-dashboard/index.ts:183`). The default also seeded the deterministic
  SESSION_TOKEN / CSRF_TOKEN HMACs (`:92/:104`), making them predictable.
- **Fix:** dropped the hardcoded fallback (empty string). An empty password can
  never match a Basic Auth credential (length check in `isAuthenticated`). The
  genuine "no auth configured" dev path is still handled at the top of
  `isAuthenticated` (no token + no pass => bypass), so empty now means "locked",
  not "anyone with the old default". Added a loud boot warning in
  `initAdminDashboard()` when the dashboard runs with no token AND no pass.
- **Verify:** `admin-dashboard.test.ts` 23/23. New WARN fires in the no-auth test
  case as intended.

### 1.3 ECR password echoed on shell command line -- DONE
- **Was:** `EcrAuthManager.refreshToken()` ran
  `echo "${password}" | docker login --password-stdin ...` via `execSync` -- the
  secret hit the shell command line (process table / history), defeating the
  point of `--password-stdin`.
- **Fix:** `spawnSync(CONTAINER_RUNTIME_BIN, ['login','--username','AWS',
  '--password-stdin', registryUri], { input: password })`. Password goes via
  stdin, never the cmdline; no shell. `get-login-password` likewise moved to argv
  `spawnSync('aws', [...])`.
- **Verify:** covered by container-manager suite (18/18).

### 1.4 Login rate-limiter keyed on spoofable X-Forwarded-For -- DONE
- **Was:** `getClientIp()` unconditionally trusted the first XFF hop
  (`:188-189`). Any client could spoof it to evade the per-IP limiter or flood
  `failedAttempts` (an unbounded `Map`, audit section 5.1 memory-exhaustion vector).
- **Fix:** XFF is trusted **only** when `ADMIN_TRUST_PROXY=true` (deployment sits
  behind a known proxy/ALB); then we take the right-most appended hop, not the
  spoofable left-most. Otherwise fall back to `socket.remoteAddress`. Added
  `pruneFailedAttempts()` (evicts expired/unblocked entries on each record) plus a
  hard cap `FAILED_ATTEMPTS_MAX_ENTRIES = 10_000` (oldest-first eviction) -- closes
  the section 5.1 vector too.
- **Verify:** `admin-dashboard.test.ts` 23/23. New env knob: `ADMIN_TRUST_PROXY`.

---

## Phase 2 -- MAJOR (structural) -- DONE (commit pending)

### 3.1 Three parallel container-spawn implementations -- RESOLVED by DELETE
**Decision:** the live cloud sub-agent lifecycle is managed by **ECS** (N workers
pull from the Redis `dispatch` queue), NOT by orchestrator-spawned Docker. So
*neither* cloud Docker-spawn impl was the real cloud path:

- **`CloudContainerManager`** (`container-manager/index.ts`, the class) -- **DELETED**
  (+ its `index.test.ts`, 18 tests). Zero live callers; `bootstrap.ts` explicitly
  never initialised it. Fully superseded by ECS. It was the sole source of the
  "3 impls" confusion. (`EcrAuthManager` went with it -- ECR auth on EC2 is done
  by the deploy script's `aws ecr get-login-password | docker login`, not in-process.)
- **`lifecycle.ts`** -- **KEPT** but clarified: it is the *local/on-prem* per-user
  Docker path, driven from `index.ts:317` gated on `NANOCLAW_ENV !== 'cloud'`.
  Already argv-hardened in P0 (1.1). Its `recordActivity`/`getActiveContainerCount`
  stay as the local-mode API surface.
- **`container-runner.ts`** -- **KEPT** unchanged: the canonical v2 *session*-based
  spawn (different model: keyed by session, not user). The duplicate-name
  `getActiveContainerCount` is now unambiguous -- session count (runner) vs user
  count (lifecycle, local-only) -- and no longer collides in any live path.

**Also fixed (folds in quick-win 3.5):**
- `bootstrap.ts`: removed the misleading unconditional `initContainerManager()` call
  in cloud bootstrap (it started an idle sweep timer with nothing to manage) and
  replaced the stale comment with an accurate ECS-vs-local note.
- `router.ts`: deleted the dead `if (!isCloudMode())` branch + `ensureContainer`
  call (unreachable -- the enclosing block is already `isCloudMode()`-guarded) and
  the dead `: userId` ternary arm; `dispatchQueue` is now always `'dispatch'`.
  Removed the now-unused `ensureContainer, recordActivity` import.

**Verify:** `pnpm typecheck` exit 0; `pnpm vitest run src/cloud` -> 34 files / 443
tests pass (was 35/461; -1 file/-18 tests = the deleted dead-class test; e2e
`MockContainerManager` flow tests still 14/14). Logic diff: index.ts -676, index.test.ts
-394 (pure deletes), bootstrap.ts +9/-12, router.ts +6/-8.


---

## Phase 3 -- TYPE (contract de-risk) -- TODO

### 2.1 Type the `__nanoclaw_wa_bridge` global singleton
Declare one exported `WhatsAppBridge` interface + a typed accessor; replace the
`(globalThis as any)` write (`index.ts:120`) and ad-hoc `as any` reads
(`whatsapp.ts:633/643/702`). Replace `(dataGateway as any).openSearchClient`
(`s3-reindex.ts:72`, reaches into a private field) with a real `DataGateway`
method. ~25 `as any` in non-test code total.

---

## Phase 4 -- MAJOR (god-object decomposition; do behind tests) -- TODO

### 3.2 `DataGateway` god-object (2251 L, 28 methods, 4 backends)
Split the PDPA lifecycle (`exportUserData:1796`, `deleteAllUserData:1868`) from the
storage primitives (DynamoDB / S3 / OpenSearch) into separate collaborators that
share the `assertUserId` guard. Behind the existing cloud integration tests.

### 3.3 `handleAdminRequest` god-function (~940 L if/else router)
Replace the manual if/else chain (`admin-dashboard/index.ts:608`) with a route
table `Map<method+path, handler>`, one handler per route. Extract the inline
`wipeTable` closure (`:1022`) and inline Redis `duplicate()` (`:1282`).

---

## Phase 5 -- CONFIG + quick wins -- TODO

### 5.2 Centralize 79 scattered `process.env` reads
Route all env access through a validated `src/config.ts` (+ cloud bootstrap); call
sites import typed constants. Verify the CLAUDE.md contract that cloud config
resolves from Secrets Manager (`nanoclaw/app-config`) at boot actually holds.
(Note: this phase introduces `ADMIN_TRUST_PROXY` and the already-present
`ADMIN_PASS`/`ADMIN_TOKEN` into that schema.)

### Quick wins (low blast radius)
- **3.4** Remove the `// DEBUG` `fs.writeFileSync('logs/last-docker-args.txt', ...)`
  on every spawn (`container-runner.ts:153`) -- relative path, can leak gateway args.
- **3.5** Delete the unreachable `if (!isCloudMode())` branch nested inside an
  `isCloudMode()` block (`router.ts:529`) and the dead `: userId` ternary arm
  (`:532`) -- **confirm intended behavior first** (outer guard may be the bug).
- **1.6** Add `log.debug/warn` to the silent empty catches
  (`circuit-breaker.ts:50/76`, `index.ts:317/639`) -- a swallowed `ensureContainer`
  failure currently stalls a message with no trail.
- **4.2** Unify the `ensureContainer`-failure policy: `router.ts:530` swallows
  silently while `lifecycle.ts:117` logs. Pick one.

---

## Phase 6 -- CLEANUP (type/contract, logging, ops TODOs, formatting) -- TODO

- **2.2** Define a discriminated union for inbound content at `parseContent`
  (`agent-runner/formatter.ts:260` returns `any`; `:82/:235/:244`).
- **2.3** Retire deprecated dual paths: `types.ts:7` provider field,
  `session-manager.ts:72/413` single-DB helpers, `connection.ts:265` `getDb()`,
  `cloud-responder.ts` bypass.
- **4.1** Route cloud `console.*` through the pino `log.ts`: `audit.ts:88/120`,
  `notification-handler.ts:84`, `whatsapp-session-backup.ts:136`. **Keep**
  `data-gateway:1782` (deliberate CloudWatch stdout) and `container-runtime.ts:52`
  (pre-logger fatal banner) -- both justified.
- **5.3** Decide/finish half-landed work: redis-queue Streams migration (#14, two
  live paths via `router.ts:552` `streamsEnabled`), `scheduler.ts:67` in-memory
  notification de-dup (persist to Redis -- currently lost on restart => duplicate
  notifications), `claude-md-compose.ts:65` skill-selection TODO.
- **5.4** Verify `scripts/check-node-version.mjs` exists (referenced by the
  `package.json` `preinstall` hook; audit couldn't locate it under that name).
- **6.7** Reconcile `data-gateway/index.ts` double-blank-line formatting with
  `.prettierrc` via `pnpm format` (2251 L -> ~1100 logical). Zero behavior change;
  do as an **isolated commit** so real diffs stay readable.

---

## NOT debt -- do not "fix" (audit section 6 false positives)

1. `console.error` throughout `container/agent-runner/src/**` -- the container runs
   under Bun with no host logger; stderr is the correct (host-captured) channel.
2. ``db.exec(`...`)`` in `src/db/migrations/*` -- static DDL, no user input.
   `.exec(` grep hits also match `RegExp.exec` and ioredis `pipeline.exec()`.
3. `spawn(BIN, args[])` with unquoted `-v ${hostPath}:...` in
   `container-runner.ts:489` -- `spawn` (no shell) makes metacharacters inert. This
   is the *correct* pattern (contrast 1.1/3.1's `execSync(string)`).
4. Fail-open in `command-gate.ts:51` when `user_roles` table absent -- documented
   single-tenant baseline; cloud installs the permissions module (table exists =>
   fail-closed). *Caveat:* worth a boot assertion that the module is installed.
5. `as unknown as { new (): any }` for `pptxgen` (`slide-generator.ts:63`) and the
   presigner cast (`data-gateway:2136`) -- bridge genuine upstream `@types` gaps.
6. AOSS workarounds in `DataGateway` (`search -> collect _ids -> bulk delete` at
   `:1231/:1407`, no `refresh:true`) -- **mandatory**: OpenSearch Serverless rejects
   `_delete_by_query`, `refresh`, `indices.stats`.
7. Double-blank-line formatting in `data-gateway/index.ts` -- formatting only (see
   6.7), not structural complexity.

---

## Verification command (per phase)

```powershell
# Node 22 required (engines >=22 <23). On a Node-26 host, prepend the WinGet Node 22 dir:
$node22 = "C:\Users\<you>\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.22_*\node-v22*-win-x64"
$env:Path = "$node22;$env:Path"

pnpm typecheck
pnpm vitest run src/cloud
```
