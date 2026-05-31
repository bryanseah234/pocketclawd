# Clawd / NanoClaw — Cloud Architecture

Clawd is a multi-user WhatsApp AI assistant deployed on AWS. End users chat with it via WhatsApp; the system processes messages, ingests documents, and replies with answers grounded in retrieval-augmented context.

**Region:** `ap-southeast-1` (Singapore — PDPA data residency)
**Account:** `709609992277`

---

## System diagram

```
                    ┌──────────────────────────────────────────────────────────┐
                    │  AWS — ap-southeast-1                                    │
                    │                                                          │
  WhatsApp Users ──▶│  EC2 r6i.4xlarge (i-0f9cd20350cfdc1a6)                    │
                    │  ┌────────────────────────────────────────────────────┐ │
                    │  │  Orchestrator container  (Node.js 22, port 3000)   │ │
                    │  │                                                    │ │
                    │  │  ┌──────────────┐  ┌────────────────────────────┐ │ │
                    │  │  │ Baileys WA   │  │ Admin UI + Landing         │ │ │
                    │  │  │ adapter      │  │ (Basic Auth, SSE pulse)    │ │ │
                    │  │  └──────┬───────┘  └────────────┬───────────────┘ │ │
                    │  │         │                       │                 │ │
                    │  │         ▼                       ▼                 │ │
                    │  │  ┌────────────────────────────────────────────┐  │ │
                    │  │  │ Router  →  Data Gateway  →  Redis queues   │  │ │
                    │  │  └─────────────────┬──────────────────────────┘  │ │
                    │  └────────────────────┼─────────────────────────────┘ │
                    │                       │                               │
                    │                       │  queue:agent:dispatch   │
                    │                       ▼                               │
                    │  ┌──────────────────────────────────────────────────┐ │
                    │  │  ECS Fargate — nanoclaw-cluster                  │ │
                    │  │  service: nanoclaw-sub-agent (2 tasks, 1024/2048)│ │
                    │  │  ┌────────────────────────────────────────────┐  │ │
                    │  │  │  Sub-agent (Python 3.11, FastAPI)          │  │ │
                    │  │  │  • RAG pipeline (embed → search → answer)  │  │ │
                    │  │  │  • Document ingestion + chunking           │  │ │
                    │  │  │  • Slash command handlers                   │  │ │
                    │  │  └────────────────────────────────────────────┘  │ │
                    │  └──────────────────────────────────────────────────┘ │
                    │                                                       │
                    │  ┌──────────────────────────────────────────────────┐ │
                    │  │  Managed services                                │ │
                    │  │                                                  │ │
                    │  │  ElastiCache Redis  nanoclaw-redis-rg        │ │
                    │  │     queues, rate-limit windows, session presence │ │
                    │  │                                                  │ │
                    │  │  OpenSearch Serverless  nanoclaw-documents       │ │
                    │  │     hybrid kNN + BM25 search, userId-filtered    │ │
                    │  │                                                  │ │
                    │  │  DynamoDB                                        │ │
                    │  │     nanoclaw-chat-messages                       │ │
                    │  │     nanoclaw-user-preferences                    │ │
                    │  │     nanoclaw-webhook-tokens (TTL)                │ │
                    │  │     nanoclaw-system-errors                       │ │
                    │  │                                                  │ │
                    │  │  S3  nanoclaw-data-709609992277                  │ │
                    │  │     staging/  users/{userId}/  drafts/  sessions/│ │
                    │  │                                                  │ │
                    │  │  Bedrock                                         │ │
                    │  │     global.anthropic.claude-sonnet-4-5  (agent)  │ │
                    │  │     global.anthropic.claude-sonnet-4-5   (both roles)│ │
                    │  │     global.cohere.embed-multilingual-v3              (1024-d) │ │
                    │  │                                                  │ │
                    │  │  Secrets Manager                                 │ │
                    │  │     nanoclaw/app-config                          │ │
                    │  │     nanoclaw/google-secrets                      │ │
                    │  │                                                  │ │
                    │  │  CloudWatch  /ecs/nanoclaw-sub-agent etc.        │ │
                    │  │  ECR  nanoclaw/orchestrator + nanoclaw/agent     │ │
                    │  └──────────────────────────────────────────────────┘ │
                    └──────────────────────────────────────────────────────────┘
```

---

## Data flow — user message

```
1.  User sends WhatsApp message
2.  Baileys adapter (in orchestrator) receives → router resolves the user
3.  Router enqueues to Redis (queue:agent:dispatch) with user metadata
4.  ECS sub-agent BRPOPs the queue
5.  Sub-agent processes:
    a.  Load last 30 messages from DynamoDB  (nanoclaw-chat-messages)
    b.  If RAG triggered: embed query (Cohere Multilingual v3) → hybrid search OpenSearch (top 3)
    c.  Call Bedrock with persona + history + context + user message
        Default model: global.anthropic.claude-sonnet-4-5-20250929-v1:0
    d.  Persist response into DynamoDB
6.  Sub-agent LPUSHes to Redis (queue:orchestrator:responses) with metadata
    that echoes channelType / platformId / threadId / kind from inbound
7.  Orchestrator response poll picks it up, wraps content as JSON {text:...},
    calls deliveryAdapter.deliver → Baileys → WhatsApp → user receives reply
```

The metadata echo on step 6 is critical — the orchestrator's cloud response poll
will reject `Cloud response missing routing fields` if the sub-agent fails to
include them.

---

## Data flow — document upload

```
1.  User uploads PDF/DOCX/PPTX/image (WhatsApp attachment or admin dashboard)
2.  File streamed to S3 (staging/{userId}/{uuid})
3.  Upload metadata enqueued to Redis (nanoclaw:uploads:pending)
4.  Data Gateway worker (in orchestrator) consumes pending list
5.  Data Gateway dispatches a document_upload action to the sub-agent queue
6.  Sub-agent processes:
    a.  Download file from S3 staging/
    b.  Extract text (PyPDF2 / python-docx / pptx-parser / OCR fallback)
    c.  Chunk: 512 tokens, 50 overlap, RecursiveCharacterTextSplitter
    d.  Embed chunks: Cohere Embed Multilingual v3, output_dimension=1024, batch=50
    e.  Index into OpenSearch with mandatory userId field
    f.  Move file from staging/ to users/{userId}/documents/
7.  Sub-agent emits a completion response → user notified via WhatsApp
```

Corporate documents follow the same path but index against the `CORPORATE`
sentinel userId. The DataGateway's `deleteAllUserData` and `exportUserData`
explicitly reject CORPORATE to prevent any user from wiping shared corpus.

---

## Data flow — RAG query

```
1.  User asks a question that the persona classifies as RAG-relevant
2.  Sub-agent embeds the query with Cohere Embed Multilingual v3 (1024-dim)
3.  Hybrid search on OpenSearch:
       70% kNN cosinesimil  +  30% BM25
       MUST clause: { term: { userId } }   ← isolation invariant
       SHOULD clause for CORPORATE if user opted in
4.  Top 3 chunks returned with source metadata (filename, page, sourceUrl)
5.  Chunks formatted into the context window of the Bedrock call
6.  Sonnet 4.5 generates the answer with inline citations
7.  Response delivered via the standard outbound flow
```

---

## Components

### Orchestrator (Node.js / TypeScript)

Entry: `src/index.ts`. Lives in a Docker container on EC2 with `--user root`
(needed for the Docker socket mount used by sub-agent management). Composed of:

- **WhatsApp adapter** — Baileys v7 (rc.9). Handles QR pairing, multi-device,
  session persistence to S3 (`sessions/` prefix).
- **Admin dashboard** — Express on port 3000. Serves `src/static/landing.html`
  at `/` and `src/static/admin.html` at `/admin` (HTTP Basic auth). Pulse strip
  fed by SSE; metric APIs at `/admin/api/{spend,queues,health}`.
- **Cloud bootstrap** — `src/cloud/bootstrap.ts`. Reads `nanoclaw/app-config`
  on boot (5-min cache + auto-refresh), wires DynamoDB / S3 / OpenSearch /
  Redis / Bedrock clients.
- **Data Gateway** — `src/cloud/data-gateway/`. Single chokepoint for every
  persistence operation; enforces userId on every read and write.
- **Data Gateway worker** — `src/cloud/data-gateway-worker/`. Consumes
  `nanoclaw:uploads:pending` and dispatches per-document work to sub-agents.
- **Response poll** — drains `queue:orchestrator:responses` and dispatches
  through the channel adapter that owns the original thread.
- **Schedulers** — `src/modules/clawd.ts` registers crons:
    02:00 SGT  cloud ingestion sweep
    03:00 SGT  Obsidian wiki regeneration
    07:00 SGT  morning digest (per opted-in user)
- **Container manager** — `src/cloud/container-manager/lifecycle.ts`. Triggers
  `aws ecs update-service ... --force-new-deployment` on new image rollout.

### Sub-agent (Python 3.11 / FastAPI)

Entry: `container/sub-agent/src/main.py`. Runs on **ECS Fargate**
(`nanoclaw-cluster/nanoclaw-sub-agent`, 1 vCPU / 2 GB / 2 tasks). Components:

- **Queue poll loop** — BRPOPs `queue:agent:dispatch`, dispatches by `kind`.
- **Bedrock client** — `container/sub-agent/src/llm/bedrock.py`. Honours
  `BEDROCK_LLM_MODEL_ID` env (precedence: env > caller arg > `DEFAULT_MODEL_ID`).
- **Embedding pipeline** — `container/sub-agent/src/embeddings/pipeline.py`.
  Region-aware selector: in `ap-southeast-1` Cohere Multilingual v3 is selected because Titan
  Embed v2 is not GA in this region. Output dimension forced to 1024 for
  OpenSearch index parity.
- **RAG pipeline** — `container/sub-agent/src/rag/`. Hybrid search → chunk
  formatting → Bedrock invocation.
- **Slash commands** — `container/sub-agent/src/commands.py`. Implements
  `/list`, `/delete`, `/forget`, `/forget-url`, `/ingested`, `/draft` etc.
  Payload contract is **snake_case** to match the worker's expectation.
- **Draft artefact generator** — `container/sub-agent/src/draft_artifacts.py`.
  Produces .docx / .pptx, uploads via the Data Gateway worker (`uploadDraft`
  action), returns a 1-hour pre-signed S3 URL.
- **Consent / PDPA** — `container/sub-agent/src/consent.py`.
  Collects consent on first contact, annual reminder, `/privacy` command,
  withdrawal removes data within 24h.

### Data Isolation (the invariant)

Every persistence operation enforces userId. Cross-user access is impossible
**by construction**, not by convention:

| Layer | Enforcement |
|---|---|
| DynamoDB | `userId` is the partition key on every table |
| OpenSearch | Every search MUST include `{ term: { userId } }` (or `bool.should` containing userId + `CORPORATE`) |
| S3 | Every key starts with `users/{userId}/` or `staging/{userId}/`; path traversal is rejected |
| Redis | Per-user rate-limit and presence keys |
| Sub-agent | Receives userId in every queue payload; never derives it |

The DataGateway is the only path to AWS state; nothing else opens a client.

---

## Infrastructure (Terraform)

Live state managed at `infrastructure/terraform/`. The map of `*.tf` to AWS
resources:

| File | Resources |
|---|---|
| `vpc.tf` | VPC, subnets, security groups, NAT gateway |
| `ec2.tf` | EC2 instance (r6i.4xlarge), IAM role, instance profile, user-data |
| `ecr.tf` | `nanoclaw/orchestrator` + `nanoclaw/agent` registries |
| `s3.tf` | `nanoclaw-data-709609992277` with lifecycle rules |
| `dynamodb.tf` | 4 tables (chat-messages, user-preferences, webhook-tokens, system-errors) |
| `opensearch.tf` | Serverless collection `nanoclaw-documents` (VECTORSEARCH) |
| `redis.tf` | ElastiCache cluster `nanoclaw-redis-rg` |
| `secrets.tf` | `nanoclaw/app-config` + `nanoclaw/google-secrets` (placeholder) |
| `cloudwatch.tf` | Log groups, retention, alarms |
| `ecs.tf` | `nanoclaw-cluster` + `nanoclaw-sub-agent` service + task def |
| `iam.tf` | Roles, policies (incl. `aoss:APIAccessAll` — required, opaque-403 otherwise) |
| `dashboard.tf` | CloudWatch dashboard |

Terraform plan is gated by tfsec in CI.

---

## Environment

The orchestrator boots into cloud mode whenever `NANOCLAW_ENV=cloud` is set
and reads everything else from `nanoclaw/app-config`. The only env vars set
on the EC2 are:

```
NANOCLAW_ENV=cloud
AWS_REGION=ap-southeast-1
USE_SUBAGENT=1
WHATSAPP_ENABLED=true
DATA_BUCKET=nanoclaw-data-709609992277
CLAWD_CRON_DIGEST=true
CLAWD_CRON_DIGEST=true
CLAWD_GOOGLE_SECRET_ID=nanoclaw/google-secrets
ADMIN_USER / ADMIN_PASS    — for /admin Basic Auth
```

The ECS sub-agent task gets `AWS_REGION=ap-southeast-1` so the embedding
pipeline resolves to Cohere Multilingual v3 automatically. Model overrides come from the
secret keys `llm_model_id` (orchestrator path) and `llm_subagent_model_id`
(sub-agent path).

---

## Deployment

CI/CD lives in `.github/workflows/`:

- `ci.yml` — typecheck, lint, vitest, pytest, tfsec. Runs on every push.
- `deploy-feature.yml` — on push to `feature/nanoclaw-aws-deployment`:
    1. Reuse CI quality gates
    2. Build orchestrator (`Dockerfile.orchestrator`) + agent (`container/sub-agent/Dockerfile`)
    3. Push to ECR with tags `<sha>` and `feature-latest`
    4. SSM the EC2: BLUE/GREEN — pre-pull as `:next`, smoke-test on `:3001`, swap to `:current`, restart orchestrator
    5. `aws ecs update-service ... --force-new-deployment` rolls the sub-agent
    6. Health-check the public `/health` endpoint
- `deploy.yml` — production rail (main branch). Same shape, plus 10-min health
  monitoring window and auto-rollback to the previous tag stored in SSM
  Parameter Store.

OIDC is used for AWS authentication; no long-lived AWS credentials live in
GitHub.
