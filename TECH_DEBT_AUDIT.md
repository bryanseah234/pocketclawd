# Technical Debt Audit -- NanoClaw / Clawd (`nanoclaw@2.0.64`)

**Date:** 2026-06-02
**Branch audited:** `feature/nanoclaw-aws-deployment` @ `f522918c`
**Scope:** `src/**` (host, 254 files) + `container/agent-runner/src/**` (agent runner). Vendored `node_modules`, build `dist/`, and the `container/` skill bundles were excluded from line-level review.
**Method:** dependency manifest + directory map + largest-file review (top 40 by bytes), then pattern sweeps for `any`, empty `catch`, `console.*`, `@deprecated`/`TODO`, `execSync`/shell-string interpolation, and per-user isolation enforcement. Every finding below is cited as `path:LINE`.

> This document is **analysis only**. No refactoring was performed. Resolve citations iteratively and re-run the test suite (`pnpm test`) after each targeted change.

---

## 0. Architecture model (orientation)

NanoClaw v2 is a single Node host that orchestrates per-session agent containers. **Everything is a message**: channel adapters -> `src/router.ts` -> per-session SQLite (`inbound.db`/`outbound.db`) -> container agent-runner -> `src/delivery.ts`. Layered on top is a substantial **AWS cloud surface** (`src/cloud/**`) -- DynamoDB/S3/OpenSearch DataGateway, Redis queue, ECS sub-agent container manager, admin dashboard -- selected at runtime via `NANOCLAW_ENV=cloud`.

The architectural fault line that produces most of the debt below: **the project carries two parallel runtimes** (local Docker host vs. AWS cloud) that re-implement the same concepts (container spawn, `getActiveContainerCount`, `assertUserId`, message enqueue) in separate files with **divergent safety guarantees**. The cloud path is newer, larger, and less consistent than the mature local core (`router.ts`, `delivery.ts`, `container-runner.ts`, which are genuinely clean).

Largest files (review-priority order): `src/cloud/admin-dashboard/index.ts` (1657 L), `src/channels/whatsapp.ts` (54 KB), `src/cloud/data-gateway/index.ts` (2251 L), `container/agent-runner/src/poll-loop.ts` (1090 L), `src/index.ts` (29 KB), `src/router.ts`, `src/container-runner.ts`.

---

## 1. Security hygiene (highest severity)

### 1.1 [CRITICAL] Shell command injection via unsanitized `userId` in cloud container spawn
`src/cloud/container-manager/lifecycle.ts:144` (sink at `:178`)

```ts
const containerName = `nanoclaw-agent-${userId.replace(/[^a-zA-Z0-9]/g, '-')}`;  // :140 -- sanitized
const envArgs = [ `-e AGENT_USER_ID=${userId}`, ... ];                            // :144 -- NOT sanitized
const cmd = ['docker run -d', `--name ${containerName}`, ..., ...envArgs, config.image].join(' ');
const output = execSync(cmd, { ... });                                            // :178 -- shell string
```

`containerName` is sanitized at `:140`, but the **raw `userId`** is then interpolated into `-e AGENT_USER_ID=${userId}` at `:144` and the whole array is `.join(' ')`'d into a string passed to `execSync` (which runs through `/bin/sh`). `userId` originates from the channel sender (see `src/router.ts:273`, `senderResolver`). A `userId` containing a space, `;`, `$( )`, or backtick injects into the docker invocation. The gateway's `assertUserId` (`src/cloud/data-gateway/index.ts:2164`) only rejects empty/`CORPORATE` -- it does **not** reject shell metacharacters, so there is no upstream guard.
**Fix direction:** use `spawn(BIN, argv[])` exactly as the sibling `src/cloud/container-manager/index.ts:184` already does (it passes an args array -- see section 3.1). Never `.join(' ')` user-derived values into an `execSync` string.

### 1.2 [HIGH] Hardcoded default admin password
`src/cloud/admin-dashboard/index.ts:183`

```ts
password: process.env.ADMIN_PASS || 'NcLaw$2026!xK9m',
```

If `ADMIN_PASS` is unset in any environment, the admin dashboard accepts a credential baked into source (and now into git history). The session/CSRF token derivation (`:92`, `:104`) keys off this same value, so the fallback also makes those tokens predictable. The dev-mode auth bypass at `:244` (`!configToken && !envToken && !envPass` -> `return true`) is acceptable for tests, but the hardcoded fallback at `:183` means a half-configured prod (token set but pass relying on default) is worse than no-auth.
**Fix direction:** fail closed -- throw at boot if `ADMIN_PASS` is missing while the dashboard is enabled; remove the literal.

### 1.3 [HIGH] Secret echoed onto a shell command line
`src/cloud/container-manager/index.ts:103`

```ts
execSync(`echo "${password}" | ${CONTAINER_RUNTIME_BIN} login --username AWS --password-stdin ${this.registryUri}`, ...)
```

The ECR password is interpolated into a shell string and piped via `echo`. `--password-stdin` exists precisely to keep the secret off argv/process listings; routing it through `echo "..."` in a shell defeats that (visible in `ps`, breaks on `"`/`$`/backtick in the token). `registryUri` is also interpolated.
**Fix direction:** `spawn(BIN, ['login','--username','AWS','--password-stdin', registryUri])` and write `password` to `child.stdin`.

### 1.4 [HIGH] Login rate-limiter keyed on spoofable `X-Forwarded-For`
`src/cloud/admin-dashboard/index.ts:187-190` (consumed at `:193`, `:211`)

```ts
const forwarded = req.headers['x-forwarded-for'];
if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
```

`getClientIp` trusts the leftmost `X-Forwarded-For` value, which is fully client-controlled. The brute-force lockout (`failedAttempts` map, `:65`) is keyed on this value, so an attacker rotating the header bypasses the 5-failure block entirely. The map is also unbounded -- distinct spoofed IPs grow it without limit (memory-exhaustion vector).
**Fix direction:** behind a known proxy, trust only the proxy's appended hop (or `req.socket.remoteAddress`); cap the map size / use the cloud Redis rate-limiter that already exists (`src/cloud/rate-limiter/index.ts`).

### 1.5 [MEDIUM] Path-traversal guard is substring-only
`src/cloud/data-gateway/index.ts:2196`

```ts
if (key.includes('../') || key.includes('..\\')) { throw ... }
```

Blocks literal `../` / `..\` but not a leading absolute `/`, URL-encoded `%2e%2e`, or a bare `..` segment without a trailing slash. The userId-prefix check at `:2210` (`key.startsWith(userId + '/')`) is the real boundary and is sound, so this is defense-in-depth rather than a confirmed bypass -- but the guard reads as authoritative and isn't.
**Fix direction:** normalize the key (`path.posix.normalize`) and re-assert the prefix on the normalized form.

### 1.6 [LOW] Empty `catch` swallows errors silently
`src/circuit-breaker.ts:50`, `src/circuit-breaker.ts:76`, `src/index.ts:317`, `src/index.ts:639`

```ts
} catch {}                                                          // circuit-breaker.ts:50, :76
if (...) { try { await ensureContainer(_dispatchUserId); } catch(_e) {} }  // index.ts:317
```

A swallowed `ensureContainer` failure (`index.ts:317`) means a container silently never spawns and the message stalls with no log trail. The circuit-breaker swallows (`:50`, `:76`) at least deserve a `log.debug`.
**Fix direction:** log at debug/warn even when the failure is intentionally non-fatal.

---

## 2. Type / contract debt

### 2.1 `as any` casts that erase real contracts (25 occurrences in non-test code)
The recurring pattern is a global mutable bridge typed as `any`:

- `src/index.ts:120` -- `(globalThis as any).__nanoclaw_wa_bridge = {...}` (the write side)
- `src/channels/whatsapp.ts:633`, `:643`, `:702`
- `src/cloud/admin-dashboard/index.ts:740`
- `src/cloud/landing-page/index.ts:28`
- `src/index.ts:578`

The WhatsApp bridge is a `globalThis`-attached singleton passed around as `any`, so every reader re-asserts its shape ad hoc and none are checked. Other casts hide AWS SDK shape gaps:
- `src/cloud/notification-handler.ts:50` (`ExclusiveStartKey: lastKey as any`), `:53`, `:70-71`
- `src/cloud/s3-reindex.ts:72` (`(dataGateway as any).openSearchClient?.count` -- reaches into a `private` field)
- `src/channels/whatsapp.ts:237` (`function buildMediaMessage(...): any`), `:497` (`normalized: any`)
- `src/channels/chat-sdk-bridge.ts:288` (`(message.author as any)?.fullName`)
- `src/index.ts:165` (`overallStatus: (...) as any`)

**Fix direction:** declare one exported `WhatsAppBridge` interface and a typed accessor; replace `(dataGateway as any).openSearchClient` (`s3-reindex.ts:72`) with a real method on `DataGateway`.

### 2.2 Untyped `content` / parser boundaries in the agent runner
`container/agent-runner/src/formatter.ts:82` (`content: any`), `:235` (`replyTo: any`), `:244` (`attachments: any[]`), `:260` (`function parseContent(json: string): any`)

`parseContent` returns `any`, so every downstream formatter operates on an untyped blob -- this is the inbound message-content contract and it's the right place to define a discriminated union.

### 2.3 Deprecated APIs still wired into live paths
- `src/types.ts:7` -- `@deprecated Use container_configs.provider instead.` (legacy provider field still on the type)
- `src/session-manager.ts:72`, `:413` -- deprecated single-DB path helpers kept alongside the two-DB ones
- `container/agent-runner/src/db/connection.ts:265` -- deprecated `getDb()` vs `getInboundDb()/getOutboundDb()`
- `src/cloud-responder.ts:4` -- `@deprecated DIRECT BYPASS PATH` still importable as a fallback

These create two ways to do the same thing; new code can pick the deprecated branch with no compiler error.

---

## 3. Architectural decay & duplicate logic

### 3.1 [MAJOR] Three parallel container-spawn implementations with divergent safety

| File | Entry | Spawn mechanism | Safety |
|------|-------|-----------------|--------|
| `src/container-runner.ts:108` | `spawnContainer(session)` | `spawn(BIN, args[])` (`:161`) | safe (argv) |
| `src/cloud/container-manager/index.ts:162` | `ContainerManager.spawn(userId)` | `spawn(BIN, args[])` (`:184`) | safe (argv) |
| `src/cloud/container-manager/lifecycle.ts:135` | `spawnContainer(userId)` | `execSync(string)` (`:178`) | **unsafe -- see 1.1** |

Two of the three build an argv array; the third joins a shell string. They also duplicate the public API: `getActiveContainerCount()` is defined identically in **both** `src/container-runner.ts:65` and `src/cloud/container-manager/lifecycle.ts:122`, and `ensureContainer`/spawn lifecycle logic is reimplemented across `index.ts` and `lifecycle.ts` within the same `container-manager/` directory.
**Fix direction:** collapse `container-manager/lifecycle.ts` into the `ContainerManager` class (or delete it if it's dead) so there's exactly one cloud spawn path, and that path uses argv.

### 3.2 [MAJOR] `DataGateway` god-object -- 2251 lines, one class, four backends
`src/cloud/data-gateway/index.ts:89`

A single `DataGateway` class owns DynamoDB (chat, prefs, webhook tokens, errors), S3 (upload/get/list/delete/draft + presign), OpenSearch (index/hybrid-search/delete), **and** PDPA export/erasure (`exportUserData:1796`, `deleteAllUserData:1868`). 28 public methods. The PDPA lifecycle and the storage primitives are different responsibilities and should be separate collaborators sharing the `assertUserId` guard.

### 3.3 [MAJOR] `handleAdminRequest` god-function -- ~940 lines, one if/else router
`src/cloud/admin-dashboard/index.ts:608`

A single function spans `:608`->`~:1545` and dispatches every admin route via a manual if/else chain (table wipes `:1022`, S3 ops `:1060`, error views `:1420`, etc.) including an inline `wipeTable` closure (`:1022`) and an inline Redis `duplicate()` (`:1282`). Untestable in isolation; every new endpoint grows the same function.
**Fix direction:** a route table (`Map<method+path, handler>`), one handler per route.

### 3.4 [MINOR] Debug artifact written on every container spawn
`src/container-runner.ts:153`

```ts
fs.writeFileSync('logs/last-docker-args.txt', args.join('\n'), 'utf-8');
```

Labeled `// DEBUG`, writes to a **relative** path (`logs/...`, depends on `process.cwd()`) on every spawn, and the docker args can include OneCLI/gateway specifics. Should be behind a debug flag or removed.

### 3.5 [MINOR] Dead branch -- `if (!isCloudMode())` nested inside `if (isCloudMode() ...)`
`src/router.ts:529`

```ts
if (isCloudMode() && wake && userId) {          // :515
  ...
  if (!isCloudMode()) {                          // :529 -- unreachable
    try { await ensureContainer(userId); } catch (e) { /* non-fatal */ }
  }
  const dispatchQueue = isCloudMode() ? 'dispatch' : userId;  // :532 -- ternary false arm also dead here
}
```

Inside a block already guarded by `isCloudMode()`, the `if (!isCloudMode())` at `:529` can never run, and the `: userId` arm of the ternary at `:532` is likewise unreachable. Either the outer guard is wrong or this is leftover from a refactor. Confirm intended behavior before deleting.

---

## 4. Inconsistent error handling & logging

### 4.1 `console.*` instead of the structured `log` in host/cloud code
The host uses a pino-based `src/log.ts`; these cloud paths bypass it:
- `src/cloud/data-gateway/index.ts:1782` -- `console.log(JSON.stringify(entry))` (a deliberate CloudWatch-stdout log, but it sidesteps the logger's redaction/levels -- see 5.1)
- `src/cloud/admin-dashboard/settings/audit.ts:88`, `:120` -- `console.error('[audit] ...')`
- `src/cloud/notification-handler.ts:84` -- `console.error('[notification] ...')`
- `src/modules/whatsapp-session-backup.ts:136` -- `console.error('[session-backup] ...')`
- `src/container-runtime.ts:52-59` -- a multi-line `console.error` banner (acceptable: fatal pre-logger startup message)

**Note on the agent runner:** the ~20 `console.error([mcp-tools] ...)` / `[poll-loop]` / `[claude-provider]` calls under `container/agent-runner/src/**` are **not** debt -- see False Positives 6.1.

### 4.2 Inconsistent failure semantics for the same operation
`src/router.ts:530` swallows an `ensureContainer` failure silently (`catch (e) { /* non-fatal */ }`) while `src/cloud/container-manager/lifecycle.ts:117` logs it (`log.error('Failed to spawn container', ...)`). Same operation, two policies. Pick one.

---

## 5. Operational / config debt

### 5.1 Unbounded in-memory maps that never evict
- `src/delivery.ts:35` (`deliveryAttempts`) and `:50` (`inflightDeliveries`) -- bounded in practice by message volume and cleaned on success/permanent-fail, low risk.
- `src/cloud/admin-dashboard/index.ts:65` (`failedAttempts`) -- **grows per distinct client IP** and, combined with the spoofable XFF key (1.4), is a memory-exhaustion vector.

### 5.2 79 direct `process.env.*` reads scattered across the codebase
Config is read inline at point-of-use rather than through a single validated config module (`src/config.ts` exists but isn't the sole source). Examples that gate security/behavior far from any schema: `src/cloud/admin-dashboard/index.ts:93/105/182/183/242/243`, `src/container-runner.ts:240`. CLAUDE.md states cloud config should resolve from Secrets Manager (`nanoclaw/app-config`) at boot; the scattered `process.env` reads make it hard to verify that contract holds.
**Fix direction:** centralize env access in `src/config.ts` (and the cloud bootstrap) with validation; have call sites import typed constants.

### 5.3 Unfinished work flagged in-code
- `src/cloud/redis-queue/index.ts:38` -- `TODO (#14): Replace Redis Lists with Streams` (a `streamsEnabled` flag path already exists in `router.ts:552`, so the migration is half-landed -- two code paths live simultaneously).
- `src/cloud/scheduler/index.ts:67` -- `TODO: Persist to Redis ... for` (notification de-dup is in-memory only; lost on restart -> duplicate notifications).
- `src/claude-md-compose.ts:65` -- `TODO (shared-source refactor): respect container.json skill selection.`

### 5.4 Node version contract lives only in prose
`.nvmrc` pins `22` while `package.json:engines` allows `>=22.0.0 <23` (consistent today). CLAUDE.md notes `better-sqlite3@11` won't build on Node 26 and exFAT needs `node-linker=hoisted` -- these constraints are documented but only partially enforced. The `package.json` `preinstall` hook references `scripts/check-node-version.mjs`; verify that file exists in the tree (the audit did not locate it under that exact name).

---

## 6. False Positives (irregular but correct given context)

These patterns look like debt to a naive sweep but are functionally necessary here:

1. **`console.error` throughout `container/agent-runner/src/**`** (`mcp-tools/*.ts:~16-20`, `poll-loop.ts:43`, `providers/claude.ts:11`, `index.ts:37`, etc.). The container runs under **Bun** with no host logger mounted; its only IO surface is the session DB. Diagnostic output **must** go to stderr, which the host captures (`src/container-runner.ts:167-171`). Using `console.error` here is the correct, intended channel.

2. **`db.exec(`...`)` in `src/db/migrations/*` and `connection.ts`.** Template-literal SQL strings, but they contain **only static DDL** (no interpolated user input). `execSync`-shaped grep hits on `.exec(` also match `RegExp.prototype.exec` (`whatsapp.ts:140`, `poll-loop.ts:891`, `threaded-reply-parser.ts:68`) and `ioredis` `pipeline.exec()` (`rate-limiter.ts:31/57`) -- none are shell or SQL-injection sinks.

3. **`spawn(BIN, args[])` with unquoted `-v ${hostPath}:${containerPath}`** in `src/container-runner.ts:489`. Looks injection-prone, but `spawn` (not `execSync`) passes argv directly to the runtime with **no shell**, so metacharacters in a path are inert. Paths are derived from validated agent-group folders (`src/group-folder.ts:5`). This is the *correct* pattern -- contrast with 1.1/3.1 where `execSync(string)` is the bug.

4. **Fail-open in `src/command-gate.ts:51`** (`if (!hasTable(db,'user_roles')) return true`). When the permissions module isn't installed there are no roles to check, so admin commands must pass -- a single-tenant local install with no permissions module is the documented baseline. The cloud/multi-user deployment installs the permissions module, which makes the table exist and the gate fail-closed. *Caveat:* correct **only** as long as the cloud deployment guarantees the module is installed; worth an explicit boot assertion rather than relying on table presence.

5. **`as unknown as { new (): any }` for `pptxgen`** (`src/modules/slide-generator.ts:63`) and the presigner cast (`data-gateway/index.ts:2136`). These bridge genuine upstream type-package mismatches (documented inline at `:2136`); narrowing them requires upstream `@types` fixes, not a local refactor.

6. **AOSS workarounds in `DataGateway`** -- the `search -> collect _ids -> bulk delete` pattern at `:1231` and `:1407` (instead of `_delete_by_query`) and the absence of `refresh:true` are **mandatory**: OpenSearch *Serverless* rejects `_delete_by_query`, `refresh`, and `indices.stats`. The verbose `as unknown as {...}` response casts around hits (`:1083`, `:1237`, `:2030`) exist because the AOSS client's response typing is loose. Correct given the platform.

7. **Double-blank-line formatting in `src/cloud/data-gateway/index.ts`** (every statement followed by a blank line -- the reason it's 2251 lines for ~1100 logical lines). A **formatting inconsistency**, not a logic defect, listed here so it isn't mistaken for structural complexity. Reconcile with the repo Prettier config (`.prettierrc`) via `pnpm format`; changes no behavior.

---

## 7. Suggested remediation order

1. **1.1** shell injection in `lifecycle.ts:144/178` -- convert to argv (or delete the file per 3.1). *Highest blast radius, user-reachable.*
2. **1.2 / 1.3 / 1.4** admin-dashboard credential + secret-on-cmdline + XFF rate-limit.
3. **3.1** collapse the duplicate cloud spawn path (removes 1.1's home and the dup `getActiveContainerCount`).
4. **2.1** type the `__nanoclaw_wa_bridge` singleton; drop `(dataGateway as any).openSearchClient`.
5. **3.2 / 3.3** decompose `DataGateway` and `handleAdminRequest` (large, do behind tests).
6. **5.2** centralize `process.env` access; **3.4 / 3.5** remove debug artifact + dead branch (quick wins).

Each fix should be verified with `pnpm typecheck && pnpm test` (and the cloud integration tests under `src/cloud/**/*.test.ts`) before moving to the next.
