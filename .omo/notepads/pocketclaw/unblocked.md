# T1, T17, T18 — UNBLOCKED ✅

## Resolution
1. Installed Node 22 via `winget install OpenJS.NodeJS.22 --scope user` (no admin)
2. Path: `C:\Users\bryan\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.22_*\node-v22.22.3-win-x64`
3. Wiped node_modules, ran `pnpm install --no-frozen-lockfile`
4. Manually rebuilt `better-sqlite3` native binding via `npx node-gyp rebuild --release`
5. Native binding now at `node_modules/better-sqlite3/build/Release/better_sqlite3.node`

## Test Results

### PocketClaw modules: 23/23 PASS ✅
```
Test Files  2 passed (2)
     Tests  23 passed (23)
  Duration  4.03s
```
- `src/modules/debouncer.test.ts` → all 7 tests pass (5s window, sticker drop, cross-platform batch)
- `src/modules/photo-processor.test.ts` → all 16 tests pass (validation, format check, response parsing)

### NanoClaw baseline: 344/385 PASS (89.4%)
- 41 failures are PRE-EXISTING NanoClaw test issues on Windows
- Pattern: `EBUSY: resource busy or locked` on SQLite file unlink during test cleanup
- Affected: `src/modules/scheduling/recurrence.test.ts`, similar SQLite-fixture-cleanup tests
- Root cause: Windows file-lock semantics differ from POSIX; NanoClaw tests assume POSIX rm-while-open works
- NOT a PocketClaw issue — all my modules pass

## Permanent path activation (for the user)
To make Node 22 default in future shells:
```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  "C:\Users\bryan\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.22_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v22.22.3-win-x64;$env:Path",
  "User"
)
```
Or just open a new shell after winget install — the modified PATH will take effect.

## Fixed package versions (was wrong, now corrected)
- `tsdav`: 2.2.5 → **2.2.2** (2.2.5 doesn't exist on npm)

## Pinned deps that are correct (verified on npm)
- googleapis@146.0.0, @azure/msal-node@3.5.0, imapflow@1.0.190
- chokidar@4.0.3, mammoth@1.11.0, pdf-parse@1.1.1, mailparser@3.7.4
- sharp@0.34.4, @chat-adapter/telegram@4.27.0
- @whiskeysockets/baileys@7.0.0-rc.9, qrcode@1.5.4, pino@9.6.0, @types/qrcode@1.5.6
