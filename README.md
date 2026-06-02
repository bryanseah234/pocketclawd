# Clawd

WhatsApp and Telegram AI assistant for busy professionals in Singapore and Southeast Asia.
Deployed on AWS ap-southeast-1, built on the NanoClaw v2 agent harness.

## What it does

- Remembers what you tell it across sessions
- Summarises documents and URLs you send
- Answers questions using your personal knowledge base
- Web search, weather, live prices, maps, news
- Generates images, PDFs and DOCX files on request
- Fires reminders to the right platform (WhatsApp or Telegram)
- Morning digest at 07:00 SGT

No app to download. Works in the WhatsApp or Telegram chat you already have.

## Live system

- Account: AWS ap-southeast-1 / 709609992277
- Admin: http://3.0.132.150:3000/admin
- WhatsApp: @pocketclaw234bot (Baileys long-poll)
- Telegram: @pocketclaw234bot (long-poll; swap to webhook after C9 Caddy)
- Sub-agent: ECS Fargate, cluster nanoclaw-cluster, service nanoclaw-sub-agent (2 tasks)
- Orchestrator: EC2 i-0f9cd20350cfdc1a6, Node.js port 3000

## Repo layout

```
src/                    Orchestrator (Node.js / TypeScript)
  channels/             WhatsApp and Telegram adapters
  cloud/                Redis queue, admin dashboard, data gateway, scheduler
  modules/              Approvals, self-mod, morning digest
container/sub-agent/    Python sub-agent (FastAPI + Bedrock)
  src/llm/              Bedrock Converse client + tool loop
  src/tools/            Web search, maps, weather, image gen, doc gen, news
  src/rag/              Embed + OpenSearch pipeline
  src/persona/          system_prompt_template.json
infrastructure/         Terraform (ECS, EC2, DynamoDB, S3, AOSS, Redis, ECR)
docs/                   All documentation
```

## Docs index

| Topic | File |
|---|---|
| System design and components | docs/architecture.md |
| AWS deploy procedure | docs/deployment.md |
| Local dev setup | docs/setup.md |
| Persona and system prompt | docs/persona.md |
| Security model | docs/security.md |
| CI/CD pipeline | docs/ci-cd.md |
| Disaster recovery runbook | docs/disaster-recovery.md |
| Live AWS resource names | docs/aws-resources.md |
| API reference | docs/api.md |
| Sub-agent internals | docs/agent-runner.md |
| Terraform infrastructure | infrastructure/README.md |
| Contributing and conventions | CONTRIBUTING.md |

## Quickstart (dev)

```bash
git clone git@github.com:tokenlab42/pocketclaw.git
cd pocketclaw
cp .env.example .env      # fill AWS creds, bot tokens, Redis URL
pnpm install
pnpm build
pnpm start
```

See docs/setup.md for full requirements.

## Tech stack

- Orchestrator: Node.js 22, TypeScript, Baileys (WhatsApp), Telegram Bot API
- Sub-agent: Python 3.12, FastAPI, boto3, httpx, lxml, reportlab, python-docx
- LLM: Claude Sonnet 4.5 via AWS Bedrock Converse
- Embeddings: Amazon Titan Embed v2
- Vector store: OpenSearch Serverless
- Cache: ElastiCache Redis 7.1
- Storage: DynamoDB (chat history, user prefs), S3 (documents, generated media)
- Infrastructure: Terraform, ECS Fargate, ECR, SSM, Secrets Manager
