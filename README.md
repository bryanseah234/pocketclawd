# Clawd

WhatsApp and Telegram AI assistant for busy professionals in Singapore and
Southeast Asia. Deployed on AWS ap-southeast-1, built on the NanoClaw v2 agent
harness.

**New here? Start with [docs/00-overview.md](docs/00-overview.md)** — a
plain-English explanation with a system diagram. For a slide-ready visual,
open [docs/diagrams/system-overview.html](docs/diagrams/system-overview.html)
in a browser.

## What it does

- Remembers what you tell it across sessions
- Summarises documents and URLs you send
- Answers from your personal knowledge base
- Web search, weather, live prices, maps, news
- Generates images, PDFs and DOCX files
- Reminders fired to the right platform; 07:00 SGT morning digest

No app to download — works in the WhatsApp or Telegram chat you already have.

## Live system

- AWS ap-southeast-1 / account 709609992277
- Admin: http://3.0.132.150:3000/admin
- WhatsApp + Telegram: `@pocketclaw234bot` (Baileys / long-poll)
- Orchestrator: EC2 `i-0f9cd20350cfdc1a6`, Node.js port 3000
- Sub-agent: ECS Fargate, cluster `nanoclaw-cluster`, service `nanoclaw-sub-agent`

## Documentation

| # | Doc | Audience |
|---|---|---|
| 00 | [Overview](docs/00-overview.md) | everyone (start here) |
| 01 | [Architecture](docs/01-architecture.md) | engineers |
| 02 | [AI Sub-agent](docs/02-sub-agent.md) | engineers |
| 03 | [Deployment](docs/03-deployment.md) | engineers / ops |
| 04 | [AWS Resources](docs/04-aws-resources.md) | ops |
| 05 | [Security](docs/05-security.md) | ops / review |
| 06 | [Operations & Runbooks](docs/06-operations.md) | ops |
| 07 | [Persona](docs/07-persona.md) | engineers |
| 08 | [API & Interfaces](docs/08-api.md) | engineers |
| — | [Local dev setup](docs/setup.md) | engineers |
| — | [Terraform infrastructure](infrastructure/README.md) | ops |
| — | [Contributing](CONTRIBUTING.md) | contributors |

Diagrams (vector SVG, zoom freely) live in
[docs/diagrams/](docs/diagrams/).

## Repo layout

```
src/                    Orchestrator (Node.js / TypeScript)
  channels/             WhatsApp and Telegram adapters
  cloud/                Redis queue, admin dashboard, data gateway, scheduler
  modules/              Approvals, self-mod, morning digest
container/sub-agent/    Python sub-agent (FastAPI + Bedrock)
  src/llm/              Bedrock Converse client + tool loop
  src/tools/            Web search, maps, weather, image/doc gen, news
  src/rag/              Embed + OpenSearch pipeline
  src/persona/          system_prompt_template.json
infrastructure/         Terraform (ECS, EC2, DynamoDB, S3, AOSS, Redis, ECR)
docs/                   All documentation + diagrams/
```

## Quickstart (dev)

```bash
git clone git@github.com:tokenlab42/pocketclaw.git
cd pocketclaw
cp .env.example .env      # AWS creds, bot tokens, Redis URL
pnpm install && pnpm build && pnpm start
```

See [docs/setup.md](docs/setup.md) for full requirements.

## Tech stack

- Orchestrator: Node.js 22, TypeScript, Baileys (WhatsApp), Telegram Bot API
- Sub-agent: Python 3.12, FastAPI, boto3, httpx, lxml, reportlab, python-docx
- LLM: Claude Sonnet 4.5 via AWS Bedrock Converse · Embeddings: Titan Embed v2
- Vector store: OpenSearch Serverless · Cache/queues: ElastiCache Redis 7.1
- Storage: DynamoDB + S3 · Infra: Terraform, ECS Fargate, ECR, SSM, Secrets Manager
