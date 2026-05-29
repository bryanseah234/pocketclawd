# Clawd / NanoClaw — Documentation index

Clawd is a WhatsApp-native AI assistant deployed on AWS (`ap-southeast-1`). The codebase reuses the upstream NanoClaw v2 harness as its agent runtime; the Clawd-specific layers — landing page, admin UI, persona, ingestion, RAG, WhatsApp adapter, AWS bootstrap — sit on top.

## Live deployment at a glance

- **Region:** `ap-southeast-1` (Singapore — PDPA data residency)
- **Account:** `709609992277`
- **Compute:** EC2 `t3.xlarge` (orchestrator + Baileys + admin) + ECS Fargate (sub-agent)
- **LLM:** AWS Bedrock — Claude Sonnet 4.5 (sub-agent), Claude Haiku 4.5 (orchestrator fallback)
- **Embeddings:** AWS Bedrock — Cohere Embed v4 (1536-dim, region-resolved)
- **Vector store:** OpenSearch Serverless `nanoclaw-documents`
- **State:** DynamoDB (4 tables) + S3 `nanoclaw-data-709609992277` + Redis `nanoclaw-redis-ec2vpc`
- **Config:** AWS Secrets Manager — `nanoclaw/app-config`, `nanoclaw/google-secrets`
- **Admin:** http://3.0.132.150:3000/admin (HTTP Basic auth)

## What to read

### Product
| Doc | When to read |
|---|---|
| [../PRD.md](../PRD.md) | Product requirements, R0–R7 scope, success criteria |
| [../PRODUCT.md](../PRODUCT.md) | Brand, audience, voice, visual identity |
| [../DESIGN.md](../DESIGN.md) | Design tokens, component spec, motion |
| [../nanoclaw-prd.html](../nanoclaw-prd.html) | Original PRD (Azure-flavoured cross-cloud reference) |

### Architecture and operations
| Doc | When to read |
|---|---|
| [architecture.md](architecture.md) | High-level system design + data flows (message, upload, RAG) |
| [architecture-diagram.md](architecture-diagram.md) | Mermaid diagrams of the NanoClaw harness |
| [CLAWD.md](CLAWD.md) | Clawd persona layer (skills, debouncer, photo pipeline, ingestion) |
| [aws-resource-inventory.md](aws-resource-inventory.md) | Snapshot of every live AWS resource (refresh from `aws describe-*`) |
| [AWS-DEPLOYMENT.md](AWS-DEPLOYMENT.md) | Full deploy procedure (Terraform → EC2 → ECS → WhatsApp pairing) |
| [SETUP.md](SETUP.md) | Local developer environment setup |
| [SPEC.md](SPEC.md) | Technical spec — stack, queue protocol, HTTP routes |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Functional + non-functional requirements |

### Security and compliance
| Doc | When to read |
|---|---|
| [SECURITY.md](SECURITY.md) | Security model — isolation, hardening, secrets, audit |
| [security-assessment.md](security-assessment.md) | Findings register, accepted risks, PDPA controls |
| [disaster-recovery.md](disaster-recovery.md) | RTO/RPO, failure scenarios, runbooks |
| [prd-gap-analysis.md](prd-gap-analysis.md) | What ships vs what the PRD asks for |

### CI/CD
| Doc | When to read |
|---|---|
| [ci-cd-overview.md](ci-cd-overview.md) | Pipeline diagram, GitHub Secrets, gates |

### Runbooks
| Doc | When to read |
|---|---|
| [runbooks/caddy-tls-setup.md](runbooks/caddy-tls-setup.md) | Add HTTPS via Caddy + Let's Encrypt |

### NanoClaw harness internals (mostly upstream — read only if extending the framework)
| Doc | When to read |
|---|---|
| [v1-to-v2-changes.md](v1-to-v2-changes.md) | Vocabulary diff between NanoClaw v1 and v2 |
| [migration-dev.md](migration-dev.md) | v1→v2 migration script + skill |
| [agent-runner-details.md](agent-runner-details.md) | The container-side poll loop and provider interface |
| [api-details.md](api-details.md) | Channel adapter and Chat SDK bridge interfaces |
| [skills-as-branches.md](skills-as-branches.md) | How feature skills are distributed as git branches |
| [SDK_DEEP_DIVE.md](SDK_DEEP_DIVE.md) | Reverse-engineering notes on `@anthropic-ai/claude-agent-sdk` |
| [BRANCH-FORK-MAINTENANCE.md](BRANCH-FORK-MAINTENANCE.md) | Forward-merging upstream into Clawd |

## Repo entry points

- **Orchestrator entry:** `src/index.ts`
- **Sub-agent entry:** `container/sub-agent/src/main.py`
- **AWS bootstrap:** `src/cloud/bootstrap.ts`
- **Admin UI:** `src/static/admin.html` (served by `src/cloud/admin-dashboard/`)
- **Landing:** `src/static/landing.html`
- **Infra:** `infrastructure/terraform/`
- **CI/CD:** `.github/workflows/deploy-feature.yml`, `.github/workflows/ci.yml`
