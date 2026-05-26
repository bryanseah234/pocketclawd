# NanoClaw Documentation

NanoClaw is a **cloud-native multi-user WhatsApp AI assistant** deployed on AWS.

## Architecture

Single EC2 instance in `ap-southeast-1` running a Node.js orchestrator + per-user
Docker containers (FastAPI sub-agents). All state lives in AWS managed services.

| Service | Purpose |
|---------|---------|
| EC2 (r6i.4xlarge) | Orchestrator + Docker host |
| ElastiCache Redis | Message queue (orchestrator ↔ sub-agents) |
| OpenSearch Serverless | Vector search (RAG document retrieval) |
| DynamoDB | Chat history, user preferences, webhook tokens |
| S3 | Document storage (staging → documents) |
| Bedrock | LLM (Claude) + embeddings (Titan v2, 1536-dim) |
| Secrets Manager | Runtime config + credential rotation |
| ECR | Docker image registry |
| CloudWatch | Logging + metrics + alerts |

## Key Documents

| Document | Description |
|----------|-------------|
| [AWS-DEPLOYMENT.md](AWS-DEPLOYMENT.md) | Full deployment guide (Terraform → EC2 → WhatsApp pairing) |
| [architecture.md](architecture.md) | System architecture and data flows |
| [SECURITY.md](SECURITY.md) | Security model (data isolation, secrets, container hardening) |
| [SETUP.md](SETUP.md) | Developer setup for contributing |
| [SPEC.md](SPEC.md) | Technical specification |

## PRD

The full product requirements document is at `nanoclaw-prd.html` in the repo root.
Open in a browser for the complete specification with Mermaid diagrams.

## CI/CD

GitHub Actions pipeline: lint → typecheck → test → tfsec → Docker build → ECR push →
staging deploy → smoke test → production deploy (with automatic rollback).

See `.github/workflows/deploy.yml`.
