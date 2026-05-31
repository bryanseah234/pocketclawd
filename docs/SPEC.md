# Clawd / NanoClaw — Technical Specification

## System identity

Clawd is a multi-user WhatsApp AI assistant deployed on AWS in `ap-southeast-1`.
End users interact via WhatsApp; the system replies with AI-generated answers
grounded in their own documents and conversation history.

**Targets:**
- 50+ concurrent users on a single EC2 (room to scale vertically)
- P95 message-to-reply latency ≤ 30 s for chat, ≤ 60 s for RAG queries
- 99.5% monthly uptime
- Zero cross-user data leakage (verified by the DataGateway invariant)

---

## Technology stack

| Layer | Technology | Why |
|---|---|---|
| Orchestrator | Node.js 22 + TypeScript | Type safety, mature WhatsApp libs (Baileys), shared NanoClaw harness |
| Sub-agent | Python 3.11 + FastAPI | Best-in-class document parsing (PyPDF2, python-docx) and Bedrock SDK |
| Channel — WhatsApp | Baileys v7 (rc.9) | Multi-device WhatsApp Web protocol; cheap; works without Meta Business API |
| Channel — Telegram | NanoClaw Chat SDK adapter | Standard NanoClaw skill-installable channel |
| LLM (sub-agent) | AWS Bedrock — `global.anthropic.claude-sonnet-4-5-20250929-v1:0` | Default reasoning model |
| LLM (orchestrator fallback) | AWS Bedrock — `global.anthropic.claude-sonnet-4-5-20250929-v1:0` | Cheap, fast, used for delivery-side classification |
| Embeddings | AWS Bedrock — `cohere.embed-multilingual-v3` | Titan v2 not GA in ap-southeast-1; output dimension forced to 1024 to keep OpenSearch index compatible |
| Vector search | OpenSearch Serverless `nanoclaw-documents` | Hybrid kNN + BM25 |
| Database | DynamoDB (4 tables) | Per-user partition key, on-demand billing, point-in-time recovery |
| Object storage | S3 `nanoclaw-data-709609992277` | Documents, drafts, WhatsApp session, exports |
| Queue | ElastiCache Redis `nanoclaw-redis-rg` (7.1.0) | Async orchestrator ↔ sub-agent |
| Secrets | AWS Secrets Manager — `nanoclaw/app-config`, `nanoclaw/google-secrets` | Runtime config + Google OAuth payload |
| Container registry | ECR — `nanoclaw/orchestrator`, `nanoclaw/agent` | Per-SHA tags + `feature-latest` / `latest` |
| Sub-agent runtime | ECS Fargate — `nanoclaw-cluster/nanoclaw-sub-agent` | 1 vCPU / 2 GB / 1 task; force-new-deployment on each rollout |
| Monitoring | CloudWatch + Bedrock token logs | Centralised logs and metrics |
| IaC | Terraform ≥ 1.5 | Plans gated by tfsec |
| CI/CD | GitHub Actions | OIDC role, no static AWS keys |

Inference profile IDs (prefixed `global.` / `apac.`) are required for these
Anthropic and Cohere models; calling `InvokeModel` against a bare model ID
returns `ValidationException: ... isn't supported`.

---

## Message queue protocol

Communication between orchestrator and sub-agent uses Redis Lists with
LPUSH/BRPOP semantics.

### Key patterns

```
queue:agent:dispatch          orchestrator → sub-agent
queue:orchestrator:responses        sub-agent → orchestrator
queue:dlq:{userId}                  per-user dead-letter queue
nanoclaw:uploads:pending            data-gateway-worker upload queue
queue:orchestrator:data_gateway     sub-agent → orchestrator data-gateway requests
```

### Message envelope

```typescript
interface QueueMessage {
  id: string;                         // ulid
  userId: string;                     // partition key everywhere downstream
  type: 'chat' | 'document_upload'    // discriminator
       | 'command' | 'data_gateway_request' | 'data_gateway_response';
  payload: Record<string, unknown>;   // shape per type — see below
  metadata?: {                        // outbound responses MUST echo these
    channelType: 'whatsapp' | 'telegram' | ...;
    platformId: string;
    threadId?: string;
    kind: 'chat' | 'media' | 'command';
  };
  timestamp: string;                  // ISO 8601
  retryCount?: number;                // 0..3 then DLQ
}
```

Sub-agent handlers MUST echo `channelType / platformId / threadId / kind` from
inbound `metadata` into response `metadata`, and the orchestrator response poll
MUST wrap `content` as `JSON.stringify({ text: rawContent })` before
`deliveryAdapter.deliver`. Failure mode is a hard error
`Cloud response missing routing fields` or `not valid JSON`.

### Sub-agent payload shapes (snake_case)

| `type` | Fields |
|---|---|
| `chat` | `text`, optional `attachments[]` |
| `document_upload` | `s3_key`, `mime_type`, `original_name`, optional `is_corporate` |
| `command` | `command`, `args[]`, optional `flags{}` |
| `data_gateway_request` | `action`, `params{}` (action-specific) |

The Python worker reads snake_case. The TypeScript orchestrator was previously
sending camelCase, which silently failed for `/list`, `/delete`, `/forget`,
`/ingested`, `/forget-url`, and `/draft` — all six fixed in commit `9abee18`.

---

## DynamoDB schema

### `nanoclaw-chat-messages`
Per-user conversation log. Partition key: `userId`. Sort key:
`timestamp#messageId`. TTL on `expireAt` (90 days).

### `nanoclaw-user-preferences`
Persona discovery and per-user toggles. Partition key: `userId`. Holds
preferences like `depth=detailed`, `domain=infrastructure`, opt-in for
morning digest, language, etc.

### `nanoclaw-webhook-tokens`
Short-lived confirmation tokens for destructive commands (`/delete`,
`/forget`, etc.). Partition key: `tokenHash` (SHA-256 of the random 32-byte
token). TTL on `ttl` (15 min). Single-use — deleted after first validation.

### `nanoclaw-system-errors`
Structured error sink. Partition key: `errorClass`. Sort key:
`timestamp#errorId`.

---

## OpenSearch index

Collection: `nanoclaw-documents` (Serverless, `VECTORSEARCH`).
Index: `documents`.

```json
{
  "mappings": {
    "properties": {
      "userId":     { "type": "keyword" },
      "documentId": { "type": "keyword" },
      "chunkId":    { "type": "keyword" },
      "text":       { "type": "text" },
      "embedding":  { "type": "knn_vector", "dimension": 1024,
                      "method": { "engine": "nmslib",
                                  "space_type": "cosinesimil",
                                  "name": "hnsw" } },
      "filename":   { "type": "keyword" },
      "page":       { "type": "integer" },
      "sourceUrl":  { "type": "keyword" },
      "timestamp":  { "type": "date" }
    }
  }
}
```

Hybrid retrieval uses a `bool` query with a kNN clause and a `match` clause,
weighted 70/30. `userId` filter is mandatory — see SECURITY.md.

The IAM policy on the EC2 role and the ECS task role MUST grant **both**
`aoss:APIAccessAll` AND a data-access policy entry. Missing the IAM action
manifests as an opaque 403 — easy to misdiagnose.

---

## HTTP routes (orchestrator)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | none | Landing page |
| GET | `/admin` | Basic | Admin dashboard |
| GET | `/admin/api/health` | Basic | JSON: Redis, DynamoDB, OpenSearch, WhatsApp session |
| GET | `/admin/api/spend` | Basic | 24h + 7d Bedrock spend, perDayUsd[] |
| GET | `/admin/api/queues` | Basic | pendingUploads, dataGatewayQueue, subAgentQueues |
| GET | `/admin/api/sse` | Basic | Server-Sent Events stream feeding pulse strip |
| POST | `/admin/api/data/users/{uid}` | Basic | Inspect user data |
| DELETE | `/admin/api/data/users/{uid}` | Basic | Delete user (PDPA) |
| GET | `/admin/api/whatsapp/qr` | Basic | Live pairing QR code (PNG, 5-min TTL) |
| GET | `/health` | none | `{ "status":"ok", "uptime", "services":{...} }` |

The admin dashboard is HTTP — wrap in Caddy + Let's Encrypt for HTTPS
(see `docs/runbooks/caddy-tls-setup.md`).

---

## Persona system (`systemPromptTemplate`)

Stored in `nanoclaw/app-config:systemPromptTemplate` as a versioned JSON
document. Sections:

- `identity` — who Clawd is and how to introduce
- `onboarding` — discovery question flow on first contact
- `responseStyle` — concision rules, list usage, citation format
- `guardrails` — banned phrases, anti-injection, tone limits
- `confidence` — HIGH / PARTIAL / NONE tiers and the escalation trigger
- `coding` — fenced blocks, version annotations, deprecation flags
- `escalation` — three-strike NONE rule, compliance topics

Hot-swappable: edit the secret, no deploy needed.

---

## Failure modes and known gotchas

- **Bedrock `ValidationException ... on-demand throughput isn't supported`** —
  use the inference-profile id (e.g. `global.anthropic.claude-sonnet-4-5-...`),
  never the bare model id.
- **AOSS opaque 403** — IAM is missing `aoss:APIAccessAll`. The data-access
  policy alone is insufficient.
- **`Cloud response missing routing fields`** — sub-agent forgot to echo
  `channelType / platformId / threadId / kind` into response metadata.
- **`not valid JSON`** in the response poll — content was passed raw instead
  of `JSON.stringify({text: rawContent})`.
- **Cygwin/MSYS git-bash crashes (`0xC0000142`) on Windows hosts** — invoke
  PowerShell directly. Affects local dev only, not production.
- **`pip install awscurl` on the EC2** — breaks the apt-installed awscli.
  Use the v2 binary or boto3 SigV4 from a workstation instead.
- **Pre-push and commit-msg hooks are sh scripts** — pass `--no-verify` on
  both `git push` and `git commit` from Windows or they'll die on cygwin
  fork without surfacing a useful error.

---

## Rate limits

| Scope | Limit | Where enforced |
|---|---|---|
| Per user | 20 messages / minute | Redis sliding window |
| Global | 200 messages / hour | Redis sliding window |
| Per user backpressure | 100 queued messages | Redis LLEN check before enqueue |
| Document size — WhatsApp | 25 MB | Baileys + magic-byte validator |
| Document size — admin | 50 MB | Multer + magic-byte validator |
| RAG query top-K | 3 chunks | Hard-coded in pipeline |

Exceeding rate limits queues the message rather than dropping it.

---

## Observability

- All HTTP and queue activity logs to CloudWatch (`/ecs/nanoclaw-sub-agent`,
  `/nanoclaw/orchestrator`).
- Bedrock invocations log token counts to a custom CloudWatch metric used by
  `/admin/api/spend`.
- Health endpoint exits non-200 on any backing service failure; the GHA deploy
  blocks promotion if `/health` fails 8 retries × 15 s.
- Pulse strip on `/admin` shows live spend / msgs / tasks / queue tiles via SSE.

---

## Compliance notes

- **PDPA (Singapore):** all user data resides in `ap-southeast-1`. Consent is
  collected on first contact; `/privacy` exposes the user's data rights;
  `/forget` triggers deletion within 24 hours. CORPORATE-tagged shared
  documents are exempt from per-user delete-all by design.
- **Encryption:** at-rest AES-256 (KMS-auto) on DynamoDB, S3, OpenSearch, and
  EBS. In-transit TLS 1.2+ to all AWS endpoints. ElastiCache `redis_tls=true`
  on the active cluster — kept private to the VPC.
- **Audit log:** `nanoclaw-system-errors` retained 1 year. WhatsApp QR scans,
  admin logins, and DSAR requests written to CloudWatch.
