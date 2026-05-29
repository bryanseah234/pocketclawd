# Clawd — A WhatsApp-native AI assistant

> **The AI assistant that actually gets to know you.**
> Built for busy professionals in Singapore and Southeast Asia. No app to install. No new interface to learn. Just WhatsApp.

[![Live](https://img.shields.io/badge/live-3.0.132.150%3A3000-2ea44f)](http://3.0.132.150:3000/admin)
[![Region](https://img.shields.io/badge/region-ap--southeast--1-blue)]()
[![Provider](https://img.shields.io/badge/LLM-AWS%20Bedrock-orange)]()
[![Status](https://img.shields.io/badge/status-production-green)]()

---

## What Clawd is

Clawd is a personal chief of staff that lives inside WhatsApp. Send it a message, photo, document, or voice note — it remembers, summarises, retrieves, and gets back to you with answers grounded in **your** knowledge, not the public internet.

This repository ships **two coexisting product surfaces** that share most of the codebase:

| Surface | Primary user | Source of truth | Provider |
|---|---|---|---|
| **Clawd Cloud** (this README) | Multi-tenant AWS deployment, WhatsApp-native | `.kiro/specs/nanoclaw-aws-deployment/`, `docs/AWS-DEPLOYMENT.md` | AWS Bedrock (Claude Sonnet 4.5 / Haiku 4.5 / Cohere Embed v4) |
| Clawd Local (legacy) | Single-user developer build, Postgres + pgvector | `PRD.md`, `docs/CLAWD.md` | Claude Code subscription |
| Azure variant | Future option, not deployed | `nanoclaw-prd.html` | Azure OpenAI gpt-4o |

Underneath both surfaces is **NanoClaw v2** — an open-source agent harness that handles message routing, per-session container lifecycle, channel adapters, and skills. See [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md) for the harness vocabulary; this README covers the Clawd-on-AWS product.

---

## Live deployment

| | |
|---|---|
| **Admin dashboard** | http://3.0.132.150:3000/admin |
| **Region** | `ap-southeast-1` (Singapore — PDPA-compliant residency) |
| **AWS account** | `709609992277` |
| **Branch of record** | `feature/nanoclaw-aws-deployment` |
| **WhatsApp number** | +65 8473 1565 (sandbox / Bryan's device pairing) |
| **Telegram** | Available via the `/add-telegram` skill |

The admin dashboard is HTTP Basic-auth protected; the credentials live in your Hermes memory store (or ask Bryan).

---

## Architecture (one paragraph)

A single **EC2 t3.xlarge** in `ap-southeast-1` runs the **Node.js orchestrator** as a Docker container. The orchestrator handles WhatsApp pairing (Baileys), the admin UI, message routing, the data gateway, schedulers (digest 07:00 SGT, wiki regen 03:00 SGT), and queue dispatch. Heavy AI work — RAG embedding, document ingestion, agent reasoning — runs in a separate **Python 3.11 sub-agent** on **ECS Fargate** (1 vCPU / 2 GB), which BRPOPs from a Redis queue. State is split across **DynamoDB** (chat history, user prefs, webhook tokens, error sink), **OpenSearch Serverless** (RAG vector search), **S3** (`nanoclaw-data-709609992277` for documents, drafts, WhatsApp session), **ElastiCache Redis** (`nanoclaw-redis-ec2vpc`, message bus), **Secrets Manager** (`nanoclaw/app-config` for runtime config, `nanoclaw/google-secrets` for Google ingestion), and **CloudWatch** for logs and metrics. Images are built and pushed to **ECR** by GitHub Actions (`deploy-feature.yml`) and shipped to EC2 via SSM.

For the long version see [docs/architecture.md](docs/architecture.md). For deploy procedure see [docs/AWS-DEPLOYMENT.md](docs/AWS-DEPLOYMENT.md). For live resource identifiers see [docs/aws-resource-inventory.md](docs/aws-resource-inventory.md).

```
WhatsApp / Telegram
        │
        ▼
  ┌─────────────────────────────────────────────────┐
  │  AWS — ap-southeast-1                           │
  │                                                 │
  │  EC2 t3.xlarge ─── Orchestrator (Node.js)       │
  │     │              + Admin UI + Baileys         │
  │     │              + Data Gateway              │
  │     ▼                                          │
  │  ┌──ElastiCache Redis (queues)─────────────┐   │
  │  │                                         │   │
  │  ▼                                         │   │
  │  ECS Fargate ─── Sub-agent (Python)        │   │
  │                  + RAG + ingestion         │   │
  │                                            │   │
  │  Bedrock ◀── Claude Sonnet 4.5 / Haiku 4.5 │   │
  │              Cohere Embed v4 (1536-dim)    │   │
  │                                            │   │
  │  DynamoDB · OpenSearch · S3 · Secrets · CW │   │
  └─────────────────────────────────────────────┘
```

---

## What Clawd does today

### Conversational
- Answers questions in plain English over WhatsApp. Sub-agent routes through Bedrock with conversation context (last 30 messages from DynamoDB) plus retrieved RAG chunks.
- Onboarding flow: discovery questions on first contact (depth preference, focus area), preferences stored in DynamoDB, applied silently to all later replies.
- Persona is configurable per-deployment via the `systemPromptTemplate` key in Secrets Manager — see [docs/CLAWD.md](docs/CLAWD.md) for the slot taxonomy (identity, onboarding, response style, guardrails, confidence tiers, coding rules, escalation).

### Document handling
- Upload via WhatsApp attachment **or** via the admin dashboard.
- Pipeline: S3 staging → Data Gateway worker → text extraction (PyPDF2, python-docx, pptx parser, OCR fallback) → 512-token chunks with 50-token overlap → Cohere v4 embeddings (1536-dim) → OpenSearch indexing with mandatory userId filter → file moved to `users/{userId}/documents/`.
- Per-user data isolation: every read enforces userId, every cross-user access is impossible by construction.
- Corporate-document mode: a special `CORPORATE` sentinel allows shared documents that any user can search but no user can delete.

### Slash commands (WhatsApp)
| Command | What it does |
|---|---|
| `/memory <fact>` | Save a fact to the user's knowledge base |
| `/recall <query>` | Hybrid search (vector + BM25) over the user's documents and memories |
| `/list` | List indexed sources |
| `/delete <id>` | Delete a specific indexed item (webhook-token confirmation) |
| `/forget` | Wipe **all** of the user's data (PDPA right to erasure) |
| `/ingested` | List ingested URLs |
| `/forget-url <url>` | Remove an ingested URL's chunks |
| `/draft <prompt>` | Generate a `.docx` or `.pptx` artefact, uploaded to S3 and returned via signed URL |
| `/digest` | Trigger today's morning digest now |
| `/wiki` | Regenerate the user's Obsidian-compatible knowledge wiki |
| `/status` | Health check + memory counts + last ingest |
| `/audit [date]` | Show recent audit log entries |
| `/privacy` | Display the user's data rights and DSAR / withdrawal options |
| `/auth google\|microsoft\|apple` | Start OAuth flow for cloud ingestion (Google live; Microsoft + Apple scaffolding) |

### Background work
- **07:00 SGT daily** — morning digest cron (calendar + emails + tasks). Off by default per user; opt-in via WhatsApp.
- **03:00 SGT daily** — Obsidian wiki regeneration from the user's knowledge base.
- **02:00 SGT daily** — cloud ingestion sweep across linked Google / Microsoft / Apple sources.
- All cron jobs are fault-isolated: a Google failure won't block a Microsoft sweep, etc.

### Admin dashboard
- Pulse strip: 24h/7d Bedrock spend, message volume, ECS task health, queue depth.
- Live WhatsApp pairing QR + session status.
- Per-user data inspector: messages, preferences, indexed docs.
- Manual ingestion / deletion controls.
- Health endpoint at `/admin/api/health` (Redis, DynamoDB, OpenSearch, WhatsApp session).
- Same "premium stationery" design system as the landing page (oatmeal #F5F0E8, espresso #3D2B1F, mustard #C9973A, Playfair Display + Inter).

---

## Repo layout

```
src/
├── index.ts                          Orchestrator entry — boot, DB, channels, schedulers
├── router.ts                         Inbound message routing
├── delivery.ts                       Outbound delivery from sub-agent → channel adapter
├── cloud/
│   ├── bootstrap.ts                  AWS service init (Secrets Manager → wired clients)
│   ├── data-gateway/                 Cross-cutting persistence: DDB, S3, OpenSearch, Redis
│   ├── data-gateway-worker/          Async ingestion + draft artefact upload worker
│   ├── admin-dashboard/              Express routes powering /admin
│   ├── container-manager/            Sub-agent lifecycle (ECS forceNewDeployment etc.)
│   └── secrets/                      AWS Secrets Manager loader (5-min cache)
├── modules/                          Clawd-specific feature modules (debouncer, photo, ingestion, wiki)
├── channels/                         Adapter registry; concrete adapters from `channels` branch
└── static/                           Landing page (landing.html) + admin UI (admin.html)

container/sub-agent/                  Python 3.11 FastAPI sub-agent (ECS Fargate)
├── src/
│   ├── commands.py                   /list, /delete, /forget, /draft, /ingested, etc.
│   ├── embeddings/pipeline.py        Region-aware Cohere v4 / Titan v2 selector
│   ├── llm/                          Bedrock client + Claude wrapper
│   ├── rag/                          Hybrid search over OpenSearch
│   ├── consent.py                    PDPA consent flow
│   └── draft_artifacts.py            .docx / .pptx generators

infrastructure/terraform/             VPC, EC2, DDB, OpenSearch, Redis, S3, IAM, ECR, CW
.kiro/specs/nanoclaw-aws-deployment/  Kiro spec — design.md, requirements.md, tasks.md
.github/workflows/
├── ci.yml                            Lint, typecheck, vitest, pytest
├── deploy-feature.yml                Build → ECR → SSM EC2 deploy + ECS forceNewDeployment
└── deploy.yml                        Production rail (main branch)

docs/                                 Architecture, security, runbooks, gap analysis
groups/clawd/                         Clawd agent identity (CLAUDE.md, skills) for NanoClaw mode
nanoclaw-prd.html                     Original Azure-flavoured PRD (kept as cross-cloud reference)
```

---

## Quickstart

> Most contributors only need the dev loop; deploy is automated by GitHub Actions.

### Prerequisites
- Node.js 22 LTS (`nvm install 22`) — Node 26 will fail `better-sqlite3` builds
- pnpm 10+ (`npm install -g pnpm`)
- Python 3.11 (sub-agent dev only)
- Docker Desktop (image builds + `docker compose up -d postgres` for legacy local mode)
- AWS CLI v2 + access to account `709609992277`, region `ap-southeast-1`
- Terraform ≥ 1.5 (only for infra changes)

### Clone and install
```bash
git clone https://github.com/tokenlab42/pocketclaw.git
cd pocketclaw
pnpm install              # add `--lockfile-only` on Windows / exFAT to skip native rebuilds
pnpm run typecheck
pnpm exec vitest run      # ≥ 460 cloud tests + 84 admin-dashboard tests
cd container/sub-agent && uv sync && uv run pytest   # 286 tests
```

### Run locally against AWS dev resources
The orchestrator boots into cloud mode whenever `NANOCLAW_ENV=cloud` is set and reads everything else (Redis endpoint, DynamoDB tables, OpenSearch URL, S3 bucket, model IDs) from `nanoclaw/app-config` in Secrets Manager.

```bash
export NANOCLAW_ENV=cloud
export AWS_REGION=ap-southeast-1
pnpm run start            # talks to live AWS — be intentional
```

### Make a change → ship it
Push to `feature/nanoclaw-aws-deployment` and `deploy-feature.yml` will:
1. Run typecheck + vitest + pytest
2. Build orchestrator + agent images, push to ECR with `:<sha>` and `:feature-latest`
3. SSM the EC2 to pull the new orchestrator and `docker run --user root` it
4. `aws ecs update-service ... --force-new-deployment` to roll the sub-agent

Failed deploys auto-rollback via the prior tag stored in SSM Parameter Store.

---

## Design system

The same "premium stationery" aesthetic powers both the landing page (`src/static/landing.html`) and the admin dashboard (`src/static/admin.html`):

- **Background** `#F5F0E8` oatmeal parchment
- **Text** `#3D2B1F` deep espresso
- **Accent** `#C9973A` mustard gold
- **Headings** Playfair Display (serif, editorial)
- **Body** Inter (clean, readable)
- **Cards** `rgba(255,255,255,0.7)` frosted white on oatmeal
- **Shadows** warm `rgba(61,43,31,0.08)` — never cold black

Full token spec at [DESIGN.md](DESIGN.md). Both pages are static HTML/CSS/JS so [impeccable](https://github.com/anthropic-experimental/impeccable) can iterate on them with zero conversion friction.

---

## Documentation map

| Doc | When you need it |
|---|---|
| [PRD.md](PRD.md) | Product requirements, success metrics, R0–R7 scope |
| [PRODUCT.md](PRODUCT.md) | One-page brand and audience summary |
| [DESIGN.md](DESIGN.md) | Colour, type, spacing, component tokens |
| [docs/AWS-DEPLOYMENT.md](docs/AWS-DEPLOYMENT.md) | Step-by-step deploy procedure |
| [docs/architecture.md](docs/architecture.md) | Long-form architecture + data flows |
| [docs/CLAWD.md](docs/CLAWD.md) | Clawd persona layer on top of NanoClaw |
| [docs/aws-resource-inventory.md](docs/aws-resource-inventory.md) | Live AWS resource names — refreshed from `aws describe-*` |
| [docs/SECURITY.md](docs/SECURITY.md) | Security model — isolation, secrets, hardening |
| [docs/security-assessment.md](docs/security-assessment.md) | Findings register, PDPA controls |
| [docs/disaster-recovery.md](docs/disaster-recovery.md) | RTO / RPO + failure scenarios |
| [docs/ci-cd-overview.md](docs/ci-cd-overview.md) | Pipeline diagram + GitHub Secrets |
| [docs/prd-gap-analysis.md](docs/prd-gap-analysis.md) | What ships vs what the PRD asks for |
| [docs/runbooks/](docs/runbooks/) | One-pagers (Caddy + TLS, etc.) |
| [docs/SETUP.md](docs/SETUP.md) | Developer environment setup |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Branch strategy, commit format, PR review |
| [nanoclaw-prd.html](nanoclaw-prd.html) | Original PRD (Azure-flavoured) — kept for cross-cloud parity |

NanoClaw harness internals (channels-as-skills, agent-runner, two-DB split) live in [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md), [docs/agent-runner-details.md](docs/agent-runner-details.md), [docs/api-details.md](docs/api-details.md), and [docs/skills-as-branches.md](docs/skills-as-branches.md). Most Clawd contributors don't need them.

---

## Status

Active. The platform is live and serving WhatsApp messages from `+65 8473 1565`. The codebase is on `feature/nanoclaw-aws-deployment` (latest deploy: SHA `9abee18`). For known gaps and next-up work see [docs/prd-gap-analysis.md](docs/prd-gap-analysis.md).

## License

Source code: MIT (see [LICENSE](LICENSE)). Branding, copy, and the persona layer are © Bryan Tan / TokenLab.

## Acknowledgements

Built on top of [NanoClaw v2](https://github.com/nanocoai/nanoclaw) by Nanoco AI. WhatsApp connectivity via [Baileys](https://github.com/WhiskeySockets/Baileys). Full contributor list in [CONTRIBUTORS.md](CONTRIBUTORS.md).
