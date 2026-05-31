# Clawd / NanoClaw — Requirements

## Product vision

Clawd is a multi-user WhatsApp AI assistant for busy professionals in Singapore
and Southeast Asia. It provides a personal-chief-of-staff experience over
WhatsApp — message memory, document Q&A, daily briefings, draft generation —
while keeping all data in the Singapore region for PDPA compliance.

This document captures functional and non-functional requirements. The deployed
system is the source of truth for what is live; this doc is the contract the
deployment is measured against.

---

## Target users

**Primary** — working professionals 25–45, mobile-first, time-poor. Live in
WhatsApp daily. Distrust complexity. Need a tool that works invisibly.

**Secondary** — operators (currently Bryan Tan as admin) who run the platform,
configure the persona, monitor health, and pair WhatsApp.

---

## Success criteria

| Metric | Target | Measurement |
|---|---|---|
| P95 chat latency | ≤ 30 s | CloudWatch metric on Bedrock invoke duration |
| P95 RAG latency | ≤ 60 s | End-to-end span from inbound to delivery |
| Document extraction accuracy | ≥ 98% on benchmark set | 100-sample regression suite |
| OCR accuracy on scanned PDFs | ≥ 80% | 50-sample regression suite |
| Monthly uptime | ≥ 99.5% (≤ 3.6h downtime) | CloudWatch availability |
| Cross-user data leakage incidents | 0 | Quarterly access-pattern audit |
| Concurrent user capacity | ≥ 50 | k6 load test (target before GA) |
| Bedrock spend per user / month | ≤ USD 5 (target) | CloudWatch + Bedrock token logs |

---

## Functional requirements

### F1 — WhatsApp messaging
The system answers WhatsApp messages from paired user accounts. Default
WhatsApp pairing is at `+65 8473 1565`. Telegram is supported via the
`/add-telegram` skill but secondary.

### F2 — Persona-driven replies
Replies are governed by the seven-tier `systemPromptTemplate` (identity,
onboarding, response style, guardrails, confidence, coding, escalation).
Persona is hot-swappable in Secrets Manager.

### F3 — Document upload + RAG
Users can upload PDF, DOCX, PPTX, TXT, MD, JPG, PNG via WhatsApp attachment or
the admin dashboard. The system extracts text (OCR fallback for scanned PDFs),
chunks, embeds via Cohere Multilingual v3, indexes into OpenSearch, and answers later
questions using hybrid (vector + BM25) retrieval. Mandatory `userId` filter
on every search.

### F4 — Slash commands
Supported: `/memory`, `/recall`, `/list`, `/delete`, `/forget`, `/forget-url`,
`/ingested`, `/draft`, `/digest`, `/wiki`, `/status`, `/audit`, `/privacy`,
`/auth google|microsoft|apple`. Every destructive command requires a webhook
token (15-minute single-use). `/draft` produces .docx or .pptx and returns a
1-hour pre-signed S3 URL.

### F5 — Background ingestion
- 02:00 SGT — sweep linked Google / Microsoft / Apple sources for new content
- 03:00 SGT — regenerate the user's Obsidian-compatible wiki
- 07:00 SGT — morning digest (calendar + email + tasks) for opted-in users

Cron jobs are fault-isolated; one source's failure must not block another.

### F6 — Admin dashboard
HTTP Basic-auth dashboard at `/admin` showing pulse strip (spend, messages,
ECS tasks, queue), live WhatsApp QR, per-user data inspector, manual
ingestion / deletion controls, health checks.

### F7 — PDPA compliance
- Consent collection on first contact
- Annual renewal reminder at 11 months
- `/privacy` command exposes data rights
- `/forget` triggers delete-all within 24 h
- DSAR export through `exportUserData`
- Singapore-region residency

### F8 — Audit log
Every data-access operation logs userId, operation, resource, timestamp,
success/failure to CloudWatch. Retained one year.

---

## Non-functional requirements

### Reliability
- Sub-agent restart on crash (ECS service `desiredCount=1`).
- Orchestrator restart-unless-stopped at the Docker layer + systemd-style
  process supervision.
- DLQ after 3 retries; manual replay path documented in DR runbook.
- Auto-rollback on production deploys after 10-minute health window.

### Scalability
- Vertical scaling path: r6i.4xlarge → r6i.xlarge → r6i.4xlarge → r6i.8xlarge.
- Sub-agent horizontally scalable via ECS `desiredCount` once load justifies.
- DynamoDB on-demand (no provisioned-capacity tuning required at low scale).
- OpenSearch Serverless minimum 2 OCUs; can swap to self-managed on EC2 to
  cut cost if traffic stays low.

### Security
- All credentials in Secrets Manager. None in code, env, or git history.
- Per-user S3 prefix `users/{userId}/`; CORPORATE sentinel for shared docs.
- OpenSearch `bool.should` filter `[{term:{userId}},{term:{userId:'CORPORATE'}}]`.
- DataGateway's `assertUserId()` blocks CORPORATE in delete-all and export.
- IAM: per-resource minimum permissions; AOSS requires
  **both** data-access policy AND `aoss:APIAccessAll`.
- HTTPS via Caddy (runbook in `docs/runbooks/caddy-tls-setup.md`).
- HTTP Basic auth on admin dashboard; rotate via Secrets Manager.

### Performance
- Sub-agent task: 1 vCPU / 2 GB on Fargate. Adequate at low concurrency.
- Redis: cache.r6g.large. Adequate; bump to r6g.large if connection count
  exceeds 1000 sustained.
- DynamoDB: on-demand, no throttling expected at < 1000 req/s.

### Cost (starter)
| Service | ~Monthly |
|---|---|
| EC2 r6i.4xlarge | ~$120 |
| ECS Fargate (1 task, 1 vCPU / 2 GB) | ~$30 |
| ElastiCache cache.r6g.large | ~$12 |
| DynamoDB (on-demand, low traffic) | ~$5 |
| OpenSearch Serverless (2 OCU min) | ~$350 |
| S3 (< 10 GB) | ~$1 |
| NAT Gateway | ~$32 |
| Secrets Manager | ~$1 |
| CloudWatch | ~$5 |
| Bedrock invocations (variable) | ~$50 |
| **Total** | **≈ $610/mo** |

OpenSearch Serverless is the dominant fixed cost. Switching to self-managed
OpenSearch on the EC2 cuts ~$350/mo at the cost of operational burden.

---

## Out of scope (today)

- Web/iOS/Android client apps. WhatsApp + Telegram are the only surfaces.
- Voice calls. Voice **notes** are transcribed, but voice calls are not.
- Real-time multi-user collaboration (e.g. shared chats with the bot).
- Public knowledge-base sharing across users (the CORPORATE sentinel is the
  only shared corpus mechanism).
- Web search. Clawd answers from the user's data only — never the open
  internet — to keep answers grounded and PDPA-clean.

---

## Architecture decisions (recap — full rationale in docs/architecture.md)

### AWS-only (vs Azure)
The original PRD (kept as `nanoclaw-prd.html`) targeted Azure. The deployed
build runs on AWS for region availability of Bedrock Claude models in
ap-southeast-1. The Azure variant remains a parallel reference for cross-cloud
parity but is not actively built.

### Sub-agent on ECS Fargate (vs per-user Docker containers)
The legacy NanoClaw v2 model was per-session Docker containers on the host.
For Clawd on AWS we run a single shared ECS Fargate task that processes all
users from a shared queue. Per-user isolation is enforced at the **data**
layer (DataGateway invariants) rather than at the **process** layer. This
trades a small attack-surface increase (a sub-agent crash affects everyone
queued behind it) for a 10x cost reduction and simpler orchestration.

### Cohere Embed Multilingual v3 (vs Titan v2)
Titan Embed v2 is not GA in `ap-southeast-1`. Cohere Embed Multilingual v3 is, returns
1024-dim vectors (matching the legacy Titan index), and is forwarded through
Bedrock with the same auth path. The pipeline picks the right model based on
the resolved AWS region.

### Hybrid retrieval over OpenSearch (vs pure vector or pure BM25)
Vector search alone misses exact-term matches in technical documents; BM25
alone misses semantic similarity in conversational queries. 70/30 weighted
hybrid is the standard ratio across published RAG benchmarks.

### Redis as message bus (vs SQS / EventBridge)
Redis is already in the stack for rate-limit windows. Adding SQS would
double the latency and double the IAM/networking surface. Redis is pinned to
the EC2 VPC with no public reachability.
