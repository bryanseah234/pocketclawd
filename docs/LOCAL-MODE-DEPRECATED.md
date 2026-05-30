# Local Mode — DEPRECATED (t4-24)

NanoClaw/Clawd is deployed **cloud-only** on AWS (Bedrock + DynamoDB +
OpenSearch + S3 + ElastiCache). Local mode is retained for development
convenience but is **not** a supported deployment surface and is on a path to
removal.

## What "local mode" is

Active when `NANOCLAW_ENV` is unset / not `cloud`. The cloud entrypoint in
`src/index.ts` is fully gated behind `isCloudMode()`; local-only modules are
reached only on the non-cloud branch (and several via lazy `await import(...)`),
so they are never loaded or executed inside a cloud container.

## Local-mode-only modules

| Module | Purpose (local only) |
|--------|----------------------|
| `src/modules/clawd.ts` | clawd cron driver (`startClawdCron`) |
| `src/modules/ingestion/scheduler.ts` | `CloudScheduler.runAll` (Google/MS/Apple ingest) |
| `src/modules/ingestion/{google,microsoft,apple,slack,github,telegram-mtproto}.ts` | source adapters |
| `src/modules/ingestion/file-watcher.ts` | filesystem watch + ingest (`watchAllConfiguredRoots`) |
| `src/modules/knowledge-base/pgvector.ts` | pgvector KB (cloud uses OpenSearch via DataGateway) |
| `src/modules/telegram-mtproto-service.ts` | MTProto connect (`startConnect`) |
| `src/modules/photo-processor.ts`, `debouncer.ts`, `wiki-generator.ts`, `mnemon-runner.ts` | local pipelines |

## Guarding

Side-effecting local entrypoints call `assertLocalMode(feature)` from
`src/cloud/bootstrap.ts`. In cloud mode it throws immediately, so an accidental
cloud invocation fails loudly instead of silently running local-only work
against cloud infra. Pure helpers (`sha256`, `chunkText`, `extractText`,
`ProcessedRegistry`) are intentionally left unguarded — they are reused by
tests and have no environment-coupled side effects.

## KB backend selection

`getKnowledgeBase()` keys on `KB_BACKEND` (default `pgvector`) via a lazy
dynamic import. Cloud mode never calls this path; the cloud KB is OpenSearch
behind `DataGateway`. If local mode is fully removed, delete `pgvector.ts` and
the `getKnowledgeBase` switch together.

## Removal checklist (deferred — requires owner sign-off)

1. Delete the modules in the table above + their `*.test.ts`.
2. Remove the non-cloud branches in `src/index.ts` (everything under the
   `if (!isCloudMode())` / `else` arms).
3. Drop `assertLocalMode` once nothing calls it.
4. Remove `KB_BACKEND` and the `getKnowledgeBase` indirection (cloud uses
   `DataGateway` directly).
5. Purge local-only env vars from docs (`WHATSAPP_AUTH_DIR` local default,
   `CLAWD_SECRETS_DIR`, `WATCH_PATHS_ROOT`, `KB_BACKEND`).

Until then, the guards keep cloud safe without losing the local dev path.
