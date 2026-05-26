# NanoClaw Cloud Architecture

## Overview

NanoClaw is a multi-user WhatsApp AI assistant deployed on AWS. Users interact
via WhatsApp; the system processes messages, manages documents, and provides
AI-powered responses with RAG (Retrieval-Augmented Generation).

**Region:** `ap-southeast-1` (Singapore)

---

## System Diagram

```
                    ┌─────────────────────────────────────────────────────┐
                    │  AWS Cloud (ap-southeast-1)                         │
                    │                                                     │
  WhatsApp Users ──▶│  EC2 Instance (r6i.4xlarge)                        │
                    │  ┌───────────────────────────────────────────────┐  │
                    │  │  NanoClaw Orchestrator (Node.js, port 3000)   │  │
                    │  │                                               │  │
                    │  │  ┌─────────────┐  ┌──────────────────────┐   │  │
                    │  │  │ Baileys WA  │  │ Admin Dashboard      │   │  │
                    │  │  │ Adapter     │  │ (Basic Auth + SSE)   │   │  │
                    │  │  └──────┬──────┘  └──────────┬───────────┘   │  │
                    │  │         │                     │               │  │
                    │  │         ▼                     ▼               │  │
                    │  │  ┌─────────────────────────────────────────┐  │  │
                    │  │  │ Router → Redis Queue → Upload Worker    │  │  │
                    │  │  └────────────────────┬────────────────────┘  │  │
                    │  │                       │                       │  │
                    │  │         ┌─────────────┼─────────────┐        │  │
                    │  │         ▼             ▼             ▼        │  │
                    │  │  ┌───────────┐ ┌───────────┐ ┌───────────┐  │  │
                    │  │  │Sub-Agent A│ │Sub-Agent B│ │Sub-Agent N│  │  │
                    │  │  │(FastAPI)  │ │(FastAPI)  │ │(FastAPI)  │  │  │
                    │  │  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘  │  │
                    │  └────────┼─────────────┼─────────────┼─────────┘  │
                    │           │             │             │             │
                    │           ▼             ▼             ▼             │
                    │  ┌─────────────────────────────────────────────┐   │
                    │  │  AWS Managed Services                       │   │
                    │  │                                             │   │
                    │  │  ElastiCache Redis    (message queues)      │   │
                    │  │  OpenSearch Serverless (vector search/RAG)  │   │
                    │  │  DynamoDB             (chat, prefs, tokens) │   │
                    │  │  S3                   (documents, staging)  │   │
                    │  │  Bedrock              (Claude + Titan embed)│   │
                    │  │  Secrets Manager      (runtime config)      │   │
                    │  │  CloudWatch           (logs + metrics)      │   │
                    │  └─────────────────────────────────────────────┘   │
                    └─────────────────────────────────────────────────────┘
```

---

## Data Flow: User Message

```
1. User sends WhatsApp message
2. Baileys adapter receives → orchestrator router
3. Router resolves userId → enqueues to Redis (queue:agent:{userId}:inbound)
4. Sub-agent container BRPOP from its inbound queue
5. Sub-agent processes:
   a. Retrieve conversation history from DynamoDB (last 30 messages)
   b. If RAG needed: embed query → hybrid search OpenSearch → get top 3 chunks
   c. Call Bedrock Claude with context + history + user message
   d. Store response in DynamoDB
6. Sub-agent LPUSH response to Redis (queue:orchestrator:responses)
7. Orchestrator response poll picks up → delivers via Baileys → user receives reply
```

---

## Data Flow: Document Upload

```
1. User uploads document (via WhatsApp or admin dashboard)
2. File streamed to S3 staging/ prefix
3. Upload metadata enqueued to Redis (nanoclaw:uploads:pending)
4. Upload Worker (orchestrator) consumes pending list
5. Dispatches document_upload message to user's sub-agent queue
6. Sub-agent processes:
   a. Download file from S3 staging/
   b. Extract text (PyPDF2, python-docx, etc.)
   c. Chunk text (512 tokens, 50 overlap, RecursiveCharacterSplitter)
   d. Embed chunks (Bedrock Titan v2, 1536 dimensions, batch 50)
   e. Index chunks into OpenSearch (with userId filter for isolation)
   f. Move file from staging/ to {userId}/documents/
7. Sub-agent sends completion response → user notified via WhatsApp
```

---

## Data Flow: RAG Query

```
1. User asks a question about their documents
2. Sub-agent embeds the query (Bedrock Titan v2)
3. Hybrid search on OpenSearch:
   - 70% vector similarity (knn, cosinesimil)
   - 30% BM25 keyword matching
   - MANDATORY userId filter on all queries (data isolation)
4. Top 3 chunks returned with source attribution
5. Chunks formatted as context for Claude
6. Claude generates answer with citations
7. Response delivered to user
```

---

## Component Details

### Orchestrator (Node.js/TypeScript)

The orchestrator is the central process running on EC2. It handles:

- **WhatsApp adapter** (Baileys v7): receives/sends messages, QR pairing
- **Admin dashboard** (port 3000): HTTP Basic Auth, SSE health updates, document upload
- **Cloud bootstrap**: connects to all AWS services via Secrets Manager config
- **Upload worker**: consumes pending uploads, dispatches to sub-agents
- **Response poll**: dequeues sub-agent responses, delivers via WhatsApp
- **Rate limiter**: 20 msg/min per user, 200 msg/hour global
- **Health check aggregator**: monitors Redis, DynamoDB, OpenSearch
- **Scheduler**: daily notifications (9:00 AM SGT), session health checks

### Sub-Agent (Python/FastAPI)

Per-user Docker containers that handle AI processing:

- **Queue poll loop**: BRPOP from Redis inbound queue
- **Document processor**: extract → chunk → embed → index
- **RAG pipeline**: embed query → hybrid search → format context → LLM
- **Document commands**: /list, /delete, /update with webhook token confirmation
- **Health endpoint**: /health for container monitoring

### Data Isolation

Every operation enforces userId isolation:

- **DynamoDB**: userId is the partition key on all tables
- **OpenSearch**: mandatory `{ term: { userId } }` filter on every query
- **S3**: keys must start with `{userId}/` — enforced by DataGateway
- **Redis**: per-user queue keys (`queue:agent:{userId}:inbound`)
- **Containers**: each user gets their own isolated Docker container

---

## Infrastructure (Terraform)

All infrastructure is defined in `infrastructure/terraform/`:

| File | Resources |
|------|-----------|
| `vpc.tf` | VPC, subnets, security groups |
| `ec2.tf` | EC2 instance, IAM role, user data |
| `ecr.tf` | Container registries (orchestrator + agent) |
| `s3.tf` | Data bucket with lifecycle rules |
| `dynamodb.tf` | 4 tables (chat, prefs, tokens, errors) |
| `opensearch.tf` | Serverless collection (VECTORSEARCH) |
| `redis.tf` | ElastiCache cluster |
| `secrets.tf` | Secrets Manager secret |
| `cloudwatch.tf` | Log groups, alarms |
| `dashboard.tf` | CloudWatch dashboard |

---

## Environment

The orchestrator loads ALL configuration from AWS Secrets Manager at startup
(`nanoclaw/app-config`). The only env vars needed on the EC2 instance are:

```bash
NANOCLAW_ENV=cloud          # Activates cloud mode
AWS_REGION=ap-southeast-1   # Default region for SDK clients
```

Everything else (Redis endpoint, DynamoDB tables, OpenSearch URL, S3 bucket,
LLM model, ECR registry) comes from the secret JSON payload.

---

## Deployment

CI/CD via GitHub Actions (`.github/workflows/deploy.yml`):

1. **Quality gates**: lint + typecheck + test + tfsec (parallel)
2. **Build**: Docker multi-stage builds → push to ECR with git-hash tags
3. **Staging**: deploy via SSM → smoke test (health endpoint)
4. **Production**: deploy via SSM → 10-min health monitoring → auto-rollback on failure

Deployments use OIDC (no long-lived AWS credentials in GitHub).
