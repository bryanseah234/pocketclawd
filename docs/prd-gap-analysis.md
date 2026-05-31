# Clawd / NanoClaw — PRD Gap Analysis

**Date:** 2026-05-29
**Branch:** `feature/nanoclaw-aws-deployment` @ `9abee18`
**Live:** http://3.0.132.150:3000/admin (Basic auth)

The PRD (`nanoclaw-prd.html`) was authored as a multi-cloud blueprint with
Azure as the primary target. The deployed build runs on **AWS in
`ap-southeast-1`** because Bedrock Claude models are GA there and PDPA
residency is satisfied. Treat the **features** as goals and the cloud
provider as an implementation detail.

The PRD is structured in three phases — A (Core), B (Personalisation /
Advanced), C (Hardening). This doc tracks each item against the live
deployment.

---

## Phase A — Core system

| Status | Item |
|---|---|
| ✅ DONE | EC2 r6i.4xlarge running, port 3000 live, container healthy |
| ✅ DONE | NanoClaw orchestrator as Docker container (`--restart unless-stopped`) |
| ✅ DONE | Sub-agent on ECS Fargate (1 task, 1 vCPU / 2 GB) |
| ✅ DONE | Baileys WhatsApp integration in orchestrator (paired `+65 8473 1565`) |
| ✅ DONE | Admin dashboard with QR code (`src/cloud/admin-dashboard/` + `src/static/admin.html`) |
| ✅ DONE | DynamoDB tables (4: chat-messages, user-preferences, webhook-tokens, system-errors) |
| ✅ DONE | OpenSearch Serverless collection `nanoclaw-documents` |
| ✅ DONE | ElastiCache Redis (`nanoclaw-redis-rg`) for message queue |
| ✅ DONE | Bedrock LLM — Sonnet 4.5 (sub-agent) + Haiku 4.5 (orchestrator) via inference profiles |
| ✅ DONE | Bedrock embeddings — Cohere Embed Multilingual v3 (Titan v2 not GA in apse1; pipeline auto-resolves by region) |
| ✅ DONE | S3 document storage (`nanoclaw-data-709609992277`) |
| ✅ DONE | Secrets Manager config (`nanoclaw/app-config`, `nanoclaw/google-secrets`) |
| ✅ DONE | RAG pipeline — hybrid kNN + BM25 in OpenSearch with mandatory userId filter |
| ✅ DONE | Per-user data isolation (DataGateway invariant) + corporate-document spec |
| ✅ DONE | Document upload via WhatsApp + admin dashboard |
| ✅ DONE | DataGateway worker (async ingestion + draft artefact uploads) |

Phase A is **complete**.

---

## Phase B — Personalisation / advanced

| Status | Item |
|---|---|
| ✅ DONE | Persona seven-tier `systemPromptTemplate` in Secrets Manager (hot-swappable) |
| ✅ DONE | Onboarding discovery (depth + focus) stored in `user-preferences` |
| ✅ DONE | Slash command coverage — `/memory`, `/recall`, `/list`, `/delete`, `/forget`, `/forget-url`, `/ingested`, `/draft`, `/digest`, `/wiki`, `/status`, `/audit`, `/privacy`, `/auth` |
| ✅ DONE | Webhook-token confirmation for destructive commands (15-min TTL, single-use) |
| ✅ DONE | Photo pipeline (vision → description → KB) |
| ✅ DONE | 5-second debouncer for chatty users |
| ✅ DONE | Cron — 02:00 SGT cloud ingestion sweep |
| ✅ DONE | Cron — 03:00 SGT Obsidian wiki regen |
| ✅ DONE | Cron — 07:00 SGT morning digest (per-user opt-in) |
| ✅ DONE | Google ingestion (Gmail + Drive + Calendar via `/auth google`) |
| 🟡 PARTIAL | Microsoft ingestion — adapter scaffolded, OAuth pending |
| 🟡 PARTIAL | Apple ingestion — adapter scaffolded, mTLS pending |
| ✅ DONE | Draft artefacts — `.docx` + `.pptx` with 1-hour pre-signed S3 URLs |
| ✅ DONE | PDPA consent + DSAR + right-to-erasure |

Phase B is **substantially complete**; Microsoft and Apple ingestion are
scaffolded but await OAuth / mTLS credentials from their respective consoles.
Google ingestion is fully wired and will activate as soon as
`nanoclaw/google-secrets` carries real tokens.

---

## Phase C — Hardening

| Status | Item |
|---|---|
| ✅ DONE | Quality gates in CI — typecheck + vitest (460+84) + pytest (286) + tfsec |
| ✅ DONE | OIDC for GitHub Actions (no static AWS keys) |
| ✅ DONE | Auto-rollback on production deploys (10-min health window + previous-tag SSM) |
| ✅ DONE | DynamoDB PITR on chat-messages |
| ✅ DONE | S3 versioning + lifecycle rules |
| ✅ DONE | CloudWatch log groups + 1-year retention on audit-tagged streams |
| ✅ DONE | Pulse-strip dashboard (24h/7d Bedrock spend, msg volume, ECS health, queue depth) |
| ✅ DONE | Health endpoint with backing-service checks |
| ❌ TODO | HTTPS via Caddy (runbook ready at `docs/runbooks/caddy-tls-setup.md`; not yet applied) |
| ❌ TODO | Lock SG ingress (22 + 3000) to admin IP set |
| ❌ TODO | External penetration test (scheduled Q3 2026) |
| ❌ TODO | k6 load test target — 50 concurrent users — before GA |

Phase C is **most-but-not-all done**; the four open items are tracked as
hardening backlog ahead of GA.

---

## Items added since the original PRD

These weren't in the PRD but emerged during the build and are live:

- **Premium-stationery design system** — oatmeal/espresso/mustard, Playfair
  Display + Inter, applied uniformly to landing + admin
  (`src/static/landing.html`, `src/static/admin.html`, `DESIGN.md`)
- **Static HTML/CSS/JS** for landing + admin (vs server-rendered template
  literals) so [impeccable](https://github.com/anthropic-experimental/impeccable)
  lives natively
- **Pulse strip** with SSE-driven live tiles
- **Cohere Embed Multilingual v3 fallback** — pipeline picks Cohere Multilingual v3 in regions where
  Titan v2 is unavailable, output forced to 1024-dim to keep the index parity
- **DataGateway worker** — `nanoclaw:uploads:pending` queue + draft artefact
  upload action, keeping the data-isolation invariant on every S3 write
- **EC2 disk-full recovery skill** — battle-tested during Bryan's ops day,
  promoted to a Hermes skill (`devops/aws-ec2-disk-full-recovery`)

---

## Items deferred from the PRD

- **Multi-region failover** — PDPA forbids serving SG users from outside
  apse1 even during an AWS outage. Single-region is the correct posture.
- **Per-user Docker isolation for the sub-agent** — replaced by the shared
  ECS Fargate task + DataGateway data-layer isolation. Cuts cost ~10x with
  no measurable security regression (process isolation was never the
  primary control).
- **Web client** — WhatsApp + Telegram are the only surfaces. The admin
  dashboard is for operators only.
- **Public knowledge sharing across users** — the `CORPORATE` sentinel is
  the only shared-corpus mechanism, by design.
- **Voice calls** — voice notes are transcribed but voice calls are not.

---

## How to test the live deployment

```bash
# Public — no auth
curl http://3.0.132.150:3000/health

# Admin dashboard — Basic auth
open http://3.0.132.150:3000/admin

# WhatsApp — message +65 8473 1565 from a paired device
# Reply round-trip should arrive within 30 s
```

Pulse-strip metric APIs (Basic auth):
```
GET /admin/api/health
GET /admin/api/spend
GET /admin/api/queues
GET /admin/api/sse        ← Server-Sent Events stream
```

Sub-agent task health:
```bash
aws ecs describe-services --cluster nanoclaw-cluster --services nanoclaw-sub-agent \
  --region ap-southeast-1 \
  --query 'services[0].{state:deployments[0].rolloutState,running:runningCount}'
```
