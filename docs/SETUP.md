# NanoClaw — Developer Setup

How to set up the development environment for contributing to NanoClaw.

**NanoClaw runs entirely on AWS.** There is no local deployment mode for the
cloud system. Development involves building/testing locally and deploying to
the AWS infrastructure via CI/CD.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 22 LTS | `nvm install 22` or [nodejs.org](https://nodejs.org) |
| pnpm | 10+ | `npm install -g pnpm` |
| AWS CLI | v2 | [aws.amazon.com/cli](https://aws.amazon.com/cli/) |
| Terraform | ≥ 1.5 | [terraform.io](https://www.terraform.io/downloads) |
| Docker | Latest | [docker.com](https://docker.com) (for building images) |
| Python | 3.11+ | For sub-agent development |

### AWS Access

You need AWS credentials with access to the NanoClaw account (`709609992277`):

```bash
aws configure
# Region: ap-southeast-1
# Output: json

# Verify:
aws sts get-caller-identity
```

---

## 1. Clone and Install

```bash
git clone https://github.com/tokenlab42/clawd.git
cd clawd
pnpm install
pnpm run build
```

---

## 2. Environment Configuration

```bash
cp .env.sample .env
```

Required variables:

```bash
# Cloud mode (activates AWS services)
NANOCLAW_ENV=cloud
AWS_REGION=ap-southeast-1

# S3 bucket (Terraform-created)
DATA_BUCKET=nanoclaw-data-709609992277

# ElastiCache Redis endpoint
REDIS_URL=redis://nanoclaw-redis-ec2vpc.sipa0z.0001.apse1.cache.amazonaws.com:6379

# WhatsApp (for local testing with Baileys)
TELEGRAM_BOT_TOKEN=<from-botfather>
TELEGRAM_ALLOWED_CHAT_ID=<your-chat-id>
```

All other config (DynamoDB tables, OpenSearch endpoint, Bedrock model, ECR registry)
is loaded at runtime from AWS Secrets Manager (`nanoclaw/app-config`).

---

## 3. AWS Infrastructure

Infrastructure is managed via Terraform in `infrastructure/terraform/`.

```bash
cd infrastructure/terraform
terraform init
terraform plan    # Review changes
terraform apply   # Deploy (requires admin access)
```

### Live Resources

| Resource | Identifier |
|----------|-----------|
| S3 Bucket | `nanoclaw-data-709609992277` |
| ElastiCache | `nanoclaw-redis-ec2vpc` |
| OpenSearch | `nanoclaw-documents` (collection ID: `66ik2p21jw225em9uj25`) |
| DynamoDB | `nanoclaw-chat-messages`, `nanoclaw-user-preferences`, `nanoclaw-webhook-tokens`, `nanoclaw-system-errors` |
| Secrets | `nanoclaw/app-config` |
| ECR | `nanoclaw/orchestrator`, `nanoclaw/agent` |

---

## 4. Development Workflow

### Orchestrator (TypeScript)

```bash
pnpm run dev          # Run with tsx (hot reload)
pnpm run typecheck    # Type checking
pnpm run lint         # ESLint
pnpm run test         # Vitest
pnpm run build        # Compile to dist/
```

### Sub-Agent (Python)

```bash
cd container/sub-agent
pip install -e .
uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
```

### Docker Images

```bash
# Orchestrator
docker build -f Dockerfile.orchestrator -t nanoclaw-orchestrator .

# Sub-agent
docker build -f container/sub-agent/Dockerfile -t nanoclaw-agent container/sub-agent/
```

---

## 5. Deployment

Push to `main` or `staging` triggers the CI/CD pipeline:

1. Quality gates (lint, typecheck, test, tfsec)
2. Docker build → push to ECR
3. Deploy to staging via SSM
4. Smoke test (health endpoint)
5. Deploy to production (main only, with auto-rollback)

Manual deployment:

```bash
# Push to staging
git push origin feature/my-change:staging

# Or merge to main for production
gh pr create --base main
```

---

## 6. Testing

```bash
# Host tests (vitest)
pnpm run test

# Sub-agent tests (pytest)
cd container/sub-agent
pytest

# Type checking
pnpm run typecheck
```

---

## 7. Monitoring

- **CloudWatch Logs**: `/nanoclaw/app/*`
- **Health endpoint**: `https://<instance-ip>:3000/health`
- **Admin dashboard**: `https://<instance-ip>:3000/admin`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Upload fails with "DATA_BUCKET not configured" | Missing env var | Set `DATA_BUCKET=nanoclaw-data-709609992277` |
| Redis connection refused | Not pointing at ElastiCache | Check `REDIS_URL` points to AWS endpoint |
| Secrets Manager access denied | IAM permissions | Ensure your role has `secretsmanager:GetSecretValue` |
| OpenSearch 403 | Missing data access policy | Check Terraform `opensearch.tf` access policy |
| Docker build fails | Node version mismatch | Use Node 22 (check `.nvmrc`) |
