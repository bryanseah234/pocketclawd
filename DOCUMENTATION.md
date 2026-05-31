# Clawd — Documentation Map

> **Start here.** This is the front door to every document in the repository,
> organised by *who needs it* and *what question it answers*. Clawd is a
> WhatsApp-native AI assistant running in production on AWS (`ap-southeast-1`,
> account `709609992277`), built on the open-source NanoClaw v2 agent harness.

**Last verified against live infrastructure:** 2026-05-31.

---

## Live system at a glance

| | |
|---|---|
| **Product** | WhatsApp-native AI assistant ("personal chief of staff") |
| **Region / account** | `ap-southeast-1` (Singapore, PDPA residency) / `709609992277` |
| **Branch of record** | `feature/nanoclaw-aws-deployment` |
| **Compute** | EC2 `r6i.4xlarge` (orchestrator + Baileys + admin) + ECS Fargate (sub-agent, 2 tasks) |
| **LLM** | AWS Bedrock - Claude Sonnet 4.5 (orchestrator **and** sub-agent) |
| **Embeddings** | AWS Bedrock - `cohere.embed-multilingual-v3` (1024-dim) |
| **Vector store** | OpenSearch Serverless `nanoclaw-documents` |
| **Message bus** | ElastiCache Redis replication group `nanoclaw-redis-rg` (primary + replica, TLS + AUTH) |
| **State** | DynamoDB (4 tables) + S3 `nanoclaw-data-709609992277` |
| **Config / secrets** | AWS Secrets Manager - `nanoclaw/app-config`, `nanoclaw/google-secrets` |
| **IaC** | Terraform - state `s3://nanoclaw-tfstate-709609992277`, S3-native locking |
| **CI/CD** | GitHub Actions -> ECR -> blue/green deploy via SSM |
| **Host access** | AWS SSM Session Manager only (SSH / port 22 closed) |

---

## 1. Executive & Product  *(for leadership, stakeholders, onboarding)*

| Document | Answers |
|---|---|
| [README.md](README.md) | What Clawd is, the live deployment, how the pieces fit. **Read this first.** |
| [PRODUCT.md](PRODUCT.md) | Brand, target audience, voice, visual identity |
| [PRD.md](PRD.md) | Product requirements (R0-R7). *Historical - documents the original single-user vision; the local build has since been removed.* |
| [DESIGN.md](DESIGN.md) | Design system - tokens, components, motion |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Functional + non-functional requirements, acceptance criteria |

## 2. Architecture  *(for engineers - how it works)*

| Document | Answers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System design, data flows (message / upload / RAG), component map |
| [docs/SPEC.md](docs/SPEC.md) | Technical spec - stack, Redis queue protocol, HTTP routes, index mappings |
| [docs/CLAWD.md](docs/CLAWD.md) | The Clawd layer on top of NanoClaw - skills, debouncer, photo pipeline, ingestion, crons |
| [docs/SDK_DEEP_DIVE.md](docs/SDK_DEEP_DIVE.md) | Agent SDK / runtime internals |
| [docs/architecture-diagram.md](docs/architecture-diagram.md) | Mermaid diagrams of the harness |
| [CLAUDE.md](CLAUDE.md) | Engineering quick-reference - entity model, two-DB split, key files, gotchas |

## 3. Operations & Deployment  *(for running it in production)*

| Document | Answers |
|---|---|
| [docs/AWS-DEPLOYMENT.md](docs/AWS-DEPLOYMENT.md) | Full deploy procedure - Terraform -> EC2 -> ECS -> WhatsApp pairing |
| [docs/ci-cd-overview.md](docs/ci-cd-overview.md) | What CI/CD does, the blue/green pipeline, quality gates |
| [docs/aws-resource-inventory.md](docs/aws-resource-inventory.md) | Snapshot of every live AWS resource (refresh from `aws describe-*`) |
| [docs/disaster-recovery.md](docs/disaster-recovery.md) | Failure scenarios + recovery runbooks (SSM-based) |
| [infrastructure/README.md](infrastructure/README.md) | Terraform layout, state, cost notes |
| [infrastructure/terraform/BLUE-GREEN-RUNBOOK.md](infrastructure/terraform/BLUE-GREEN-RUNBOOK.md) | Zero-downtime deploy mechanics |
| [infrastructure/terraform/REDIS-CUTOVER.md](infrastructure/terraform/REDIS-CUTOVER.md) | Redis HA migration. *Status: COMPLETE - historical reference.* |
| [docs/runbooks/caddy-tls-setup.md](docs/runbooks/caddy-tls-setup.md) | TLS / HTTPS front-door setup |
| [docs/SETUP.md](docs/SETUP.md) | Local developer environment setup |

## 4. Security & Compliance  *(for audit, review, risk)*

| Document | Answers |
|---|---|
| [docs/SECURITY.md](docs/SECURITY.md) | Security model - network controls, data isolation, secret rotation |
| [docs/security-assessment.md](docs/security-assessment.md) | Live findings register (accepted risks + hardening backlog) |

## 5. Reference & History  *(deeper dives, decisions, maintenance)*

| Document | Answers |
|---|---|
| [docs/README.md](docs/README.md) | Detailed documentation index (engineering-facing) |
| [.kiro/specs/nanoclaw-aws-deployment/](.kiro/specs/nanoclaw-aws-deployment/) | The AWS-deployment spec - **source of truth** for the cloud architecture (requirements / design / tasks) |
| [docs/prd-gap-analysis.md](docs/prd-gap-analysis.md) | PRD vs. as-built gap analysis |
| [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md) | NanoClaw harness vocabulary (v1 -> v2) |
| [docs/skills-as-branches.md](docs/skills-as-branches.md) - [docs/BRANCH-FORK-MAINTENANCE.md](docs/BRANCH-FORK-MAINTENANCE.md) | How channel/provider skills are distributed across branches |
| [docs/migration-dev.md](docs/migration-dev.md) | v1 -> v2 migration internals |
| [docs/LOCAL-MODE-DEPRECATED.md](docs/LOCAL-MODE-DEPRECATED.md) | Why local/Postgres mode was removed |
| [CONTRIBUTING.md](CONTRIBUTING.md) - [CONTRIBUTORS.md](CONTRIBUTORS.md) | Commit conventions, branch naming, contributors |
| [docs/agent-runner-details.md](docs/agent-runner-details.md) - [docs/api-details.md](docs/api-details.md) | Component-level reference |

> **Note on the Azure variant:** `nanoclaw-prd.html` documents an Azure (Cosmos
> DB / AI Search / gpt-4o) build as a *future option*. It is not deployed; the
> live product is AWS-only.

---

## Suggested reading paths

- **New to the project?** -> README.md -> docs/architecture.md -> docs/CLAWD.md
- **Showing leadership?** -> README.md -> PRODUCT.md -> this map's "at a glance" table
- **On call / incident?** -> docs/disaster-recovery.md -> docs/aws-resource-inventory.md
- **Deploying a change?** -> docs/ci-cd-overview.md -> docs/AWS-DEPLOYMENT.md
- **Security review?** -> docs/SECURITY.md -> docs/security-assessment.md
