# AWS Resource Inventory — Live Snapshot

> Captured **2026-05-31 16:23 UTC** via read-only `aws describe-*` / `list-*` calls against
> account `709609992277`, region `ap-southeast-1`, profile `clawd-prod`.
> Only Clawd (`nanoclaw-*`) resources are listed; unrelated workloads sharing
> the account are intentionally excluded.

## Compute

| Resource | Identifier | Detail |
|---|---|---|
| EC2 (orchestrator host) | `i-0f9cd20350cfdc1a6` | `r6i.4xlarge`, `ap-southeast-1a`, public IP `3.0.132.150`, state `running` |
| Security group | `sg-04077e2294b216bbc` (`nanoclaw-ec2-…`) | inbound: `:3000` (0.0.0.0/0), `:443` (0.0.0.0/0), `:6379` (intra-SG). **Port 22 / SSH CLOSED — SSM-only access.** |
| ECS cluster | `nanoclaw-cluster` | Fargate |
| ECS service | `nanoclaw-sub-agent` | task def `nanoclaw-sub-agent:11`, **desired 2 / running 2**, 1 vCPU / 2 GB each |

## Data & State

| Resource | Identifier | Detail |
|---|---|---|
| DynamoDB | `nanoclaw-chat-messages` | chat history (PITR on; 90-day TTL) |
| DynamoDB | `nanoclaw-user-preferences` | per-user prefs / consent |
| DynamoDB | `nanoclaw-system-errors` | error sink |
| DynamoDB | `nanoclaw-webhook-tokens` | webhook auth tokens |
| S3 | `nanoclaw-data-709609992277` | documents, drafts, WhatsApp session |
| S3 | `nanoclaw-tfstate-709609992277` | Terraform state (S3-native locking via `use_lockfile`) |
| OpenSearch Serverless | collection `nanoclaw-documents` | RAG vector + hybrid search |
| ElastiCache Redis | replication group `nanoclaw-redis-rg` | engine available, **2 nodes**, **TLS on**, **AUTH on**, private to VPC, message bus |

## Secrets & Registry

| Resource | Identifier | Detail |
|---|---|---|
| Secrets Manager | `nanoclaw/app-config` | runtime config: model IDs, table names, endpoints, limits (injected at boot, never in env/chat) |
| Secrets Manager | `nanoclaw/google-secrets` | Google ingestion OAuth |
| ECR | `nanoclaw/orchestrator` | Node.js orchestrator image (`Dockerfile.orchestrator`) |
| ECR | `nanoclaw/agent` | Python 3.11 sub-agent image |

## Model layer (Bedrock, ap-southeast-1)

| Role | Model | Notes |
|---|---|---|
| Orchestrator + Sub-agent LLM | Claude Sonnet 4.5 (`global.anthropic.claude-sonnet-4-5-20250929-v1:0`) | both roles use Sonnet 4.5 |
| Embeddings | `cohere.embed-multilingual-v3` | 1024-dim (Titan v2 not GA in apse1; Marketplace subscription required) |

## CI/CD

| Item | Value |
|---|---|
| Active branch | `feature/nanoclaw-aws-deployment` |
| Pipeline | GitHub Actions `deploy-feature.yml` → build orchestrator + agent images → push ECR (`<sha8>` + `feature-latest`) → blue/green deploy to EC2 via SSM |
| CI workflow | `ci.yml` — typecheck, vitest, pytest, tfsec, gitleaks (free CLI), terraform validate, k6 smoke |
| Node runtime | Actions forced to Node 24 (`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`) |

---

*Regenerate this snapshot with read-only `aws` calls under profile `clawd-prod`; never paste secret values, only resource names.*
