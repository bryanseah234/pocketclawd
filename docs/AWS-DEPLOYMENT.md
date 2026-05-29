# Clawd / NanoClaw — AWS Deployment Guide

This is the full admin procedure to bring a fresh Clawd / NanoClaw stack live
on AWS. The deployed instance at `3.0.132.150` was built from this exact
procedure.

**Architecture summary:** EC2 `t3.xlarge` orchestrator + Baileys + admin UI;
ECS Fargate task for the Python sub-agent; managed services for state
(DynamoDB, OpenSearch Serverless, ElastiCache Redis, S3, Bedrock, Secrets
Manager); GitHub Actions for CI/CD via OIDC.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Infrastructure deployment](#2-infrastructure-deployment)
3. [Secrets configuration](#3-secrets-configuration)
4. [Docker images](#4-docker-images)
5. [EC2 setup](#5-ec2-setup)
6. [ECS sub-agent](#6-ecs-sub-agent)
7. [WhatsApp pairing](#7-whatsapp-pairing)
8. [CI/CD setup](#8-cicd-setup)
9. [Verification](#9-verification)
10. [Scaling](#10-scaling)
11. [Cost optimization](#11-cost-optimization)
12. [Teardown](#12-teardown)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Prerequisites

### Tools
| Tool | Version |
|---|---|
| Terraform | ≥ 1.5 |
| AWS CLI | v2 |
| Docker | latest |
| Node.js + pnpm | 22 LTS / pnpm 10+ |
| Python + uv | 3.11 / latest uv |
| GitHub CLI (optional) | latest |

### AWS account
- Account `709609992277` (or your equivalent)
- Region `ap-southeast-1` (Singapore — required for PDPA residency)
- IAM user / SSO with admin access for first-time provisioning
- Bedrock model access enabled in `ap-southeast-1` for the inference profiles
  `global.anthropic.claude-sonnet-4-5-20250929-v1:0`,
  `global.anthropic.claude-haiku-4-5-20251001-v1:0`, and
  `global.cohere.embed-v4:0`

```bash
aws bedrock list-inference-profiles --region ap-southeast-1
```

If any of those three are not listed, request access in the AWS console
(Bedrock → Model access) before proceeding.

---

## 2. Infrastructure deployment

```bash
cd infrastructure/terraform
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars with project name + region
terraform init
terraform plan
terraform apply
```

Resources created:

| File | Resources |
|---|---|
| `vpc.tf` | VPC, public + private subnets, NAT, security groups |
| `ec2.tf` | EC2 t3.xlarge, IAM role, instance profile, user-data |
| `ecs.tf` | `nanoclaw-cluster`, `nanoclaw-sub-agent` service + task def |
| `ecr.tf` | `nanoclaw/orchestrator` + `nanoclaw/agent` registries |
| `s3.tf` | `nanoclaw-data-{account}` data bucket with lifecycle rules |
| `dynamodb.tf` | 4 tables (chat-messages, user-preferences, webhook-tokens, system-errors) |
| `opensearch.tf` | Serverless `nanoclaw-documents` collection (VECTORSEARCH) + data-access policy |
| `redis.tf` | ElastiCache `nanoclaw-redis-ec2vpc` (cache.t3.micro, redis 7.1.0) |
| `secrets.tf` | `nanoclaw/app-config` skeleton + `nanoclaw/google-secrets` placeholder |
| `iam.tf` | EC2 instance role + ECS task role with **`aoss:APIAccessAll`** (critical) |
| `cloudwatch.tf` | Log groups + alarms + dashboard |

> **Critical:** the EC2 instance role and the ECS task role both need
> `aoss:APIAccessAll` in addition to a data-access policy entry. Missing the
> IAM action surfaces as an opaque 403 from OpenSearch — easy to misdiagnose.
> The Terraform module sets it correctly; double-check before assuming the
> data-access policy alone is enough.

After apply, capture outputs:

```bash
terraform output
```

---

## 3. Secrets configuration

Populate `nanoclaw/app-config` with the runtime config:

```bash
aws secretsmanager put-secret-value \
  --secret-id nanoclaw/app-config \
  --region ap-southeast-1 \
  --secret-string '{
    "redis_host":               "'$(terraform output -raw redis_endpoint)'",
    "redis_port":               6379,
    "redis_tls":                false,
    "dynamodb_chat_messages_table":     "nanoclaw-chat-messages",
    "dynamodb_user_preferences_table":  "nanoclaw-user-preferences",
    "dynamodb_webhook_tokens_table":    "nanoclaw-webhook-tokens",
    "dynamodb_system_errors_table":     "nanoclaw-system-errors",
    "opensearch_endpoint":      "'$(terraform output -raw opensearch_endpoint)'",
    "opensearch_index_name":    "documents",
    "s3_data_bucket":           "'$(terraform output -raw s3_data_bucket)'",
    "llm_model_id":             "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "llm_subagent_model_id":    "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "llm_region":               "ap-southeast-1",
    "BEDROCK_EMBEDDING_MODEL_ID": "global.cohere.embed-v4:0",
    "ecr_registry_url":         "'$(terraform output -raw ecr_registry_url)'",
    "ecr_agent_image":          "nanoclaw/agent:latest",
    "WHATSAPP_SESSION_S3_PREFIX": "sessions/",
    "NOTIFICATION_TIMEZONE":    "Asia/Singapore",
    "RATE_LIMIT_PER_USER_PER_MIN": 20,
    "RATE_LIMIT_GLOBAL_PER_HOUR":  200,
    "systemPromptTemplate":     {
      "version":   "1.0.0",
      "updatedAt": "...",
      "sections":  { "identity": "...", "onboarding": "...",
                     "responseStyle": "...", "guardrails": "...",
                     "confidence": "...", "coding": "...",
                     "escalation": "..." }
    }
  }'
```

The persona's seven sections are documented in `docs/CLAWD.md`.

If you intend to enable Google ingestion (`/auth google`, morning digest),
populate `nanoclaw/google-secrets`:

```bash
aws secretsmanager put-secret-value \
  --secret-id nanoclaw/google-secrets --region ap-southeast-1 \
  --secret-string '{
    "credentials": { "installed": { "client_id":"...","client_secret":"...",
                                    "redirect_uris":["..."] } },
    "token": {}
  }'
```

---

## 4. Docker images

```bash
ECR=$(terraform output -raw ecr_registry_url)
aws ecr get-login-password --region ap-southeast-1 | \
  docker login --username AWS --password-stdin "$ECR"

docker build -f Dockerfile.orchestrator     -t "$ECR/nanoclaw/orchestrator:latest" .
docker build -f container/sub-agent/Dockerfile -t "$ECR/nanoclaw/agent:latest"        .

docker push "$ECR/nanoclaw/orchestrator:latest"
docker push "$ECR/nanoclaw/agent:latest"
```

Verify:
```bash
aws ecr describe-images --repository-name nanoclaw/orchestrator --region ap-southeast-1
aws ecr describe-images --repository-name nanoclaw/agent        --region ap-southeast-1
```

CI normally does this for you on every push to `feature/nanoclaw-aws-deployment`.

---

## 5. EC2 setup

The Terraform user-data already installs Docker and the SSM agent. Connect
via SSM:

```bash
aws ssm start-session --target $(terraform output -raw ec2_instance_id)
```

Or, in a recovery scenario where SSM is broken (DNS dead from a full disk),
use EC2 Instance Connect:

```bash
aws ec2-instance-connect send-ssh-public-key \
  --instance-id $(terraform output -raw ec2_instance_id) \
  --instance-os-user ubuntu \
  --availability-zone ap-southeast-1a \
  --ssh-public-key file://~/eic-key.pub
ssh -i ~/eic-key ubuntu@$(terraform output -raw ec2_public_ip)
```

> The EIC key TTL is **60 seconds** — re-push before each ssh batch.

### Pull and start the orchestrator

```bash
ECR=$(aws ecr describe-repositories --repository-names nanoclaw/orchestrator \
       --region ap-southeast-1 --query 'repositories[0].repositoryUri' --output text)

aws ecr get-login-password --region ap-southeast-1 | \
  sudo docker login --username AWS --password-stdin "$ECR"

sudo docker pull  "$ECR:latest"
sudo docker tag   "$ECR:latest" nanoclaw-orchestrator:current

sudo docker run -d \
  --name nanoclaw-orchestrator \
  --restart unless-stopped \
  --user root \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/nanoclaw-data:/app/data \
  -e NANOCLAW_ENV=cloud \
  -e AWS_REGION=ap-southeast-1 \
  -e USE_SUBAGENT=1 \
  -e WHATSAPP_ENABLED=true \
  -e DATA_BUCKET=$(terraform output -raw s3_data_bucket) \
  -e CLAWD_CRON_DIGEST=true \
  -e CLAWD_CRON_WIKI=true \
  -e CLAWD_GOOGLE_SECRET_ID=nanoclaw/google-secrets \
  -e ADMIN_USER=admin \
  -e ADMIN_PASS=<SET-A-STRONG-PASSWORD> \
  nanoclaw-orchestrator:current
```

The `--user root` is required because the container manages the
sub-agent ECS service through the AWS SDK and the Docker socket. Without
root, the docker.sock mount is unreadable.

The `/opt/nanoclaw-data` bind mount holds local-only state (currently
`better-sqlite3` session DB + Baileys session cache before they're persisted
back to S3).

---

## 6. ECS sub-agent

Terraform creates `nanoclaw-cluster/nanoclaw-sub-agent` as a Fargate service
with `desiredCount=1`, 1 vCPU / 2 GB. To roll a new image:

```bash
aws ecs update-service \
  --cluster nanoclaw-cluster \
  --service nanoclaw-sub-agent \
  --force-new-deployment \
  --region ap-southeast-1
```

CI does this automatically on every deploy. Watch the rollout:

```bash
aws ecs describe-services --cluster nanoclaw-cluster --services nanoclaw-sub-agent \
  --region ap-southeast-1 \
  --query 'services[0].{primary:deployments[0].rolloutState,running:runningCount}'
```

Tail the logs:
```bash
aws logs tail /ecs/nanoclaw-sub-agent --follow --region ap-southeast-1
```

The task gets `AWS_REGION=ap-southeast-1` from the task def so the embedding
pipeline resolves to Cohere v4 automatically. The Bedrock model id comes from
`BEDROCK_LLM_MODEL_ID` (forwarded by `src/cloud/container-manager/lifecycle.ts`)
which the orchestrator pulls from `nanoclaw/app-config:llm_subagent_model_id`.

---

## 7. WhatsApp pairing

```bash
aws ssm start-session --target $(terraform output -raw ec2_instance_id)
sudo docker logs -f nanoclaw-orchestrator
```

The orchestrator prints a QR code to its log on first start. Scan it with
WhatsApp → Settings → Linked Devices → Link a Device.

After successful pairing the log shows:
```
[baileys] Connection open
[baileys] Session authenticated for <phone>
```

The session blob is persisted to S3 under `sessions/`, so subsequent restarts
do **not** require re-pairing.

---

## 8. CI/CD setup

### OIDC provider (one-time)
```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

### Deploy role
Create `nanoclaw-github-deploy` with a trust policy bound to your repo's
`refs/heads/*` and policies:
- `AmazonEC2ContainerRegistryPowerUser`
- `AmazonSSMFullAccess`
- ECS update-service (scoped to `nanoclaw-cluster`)
- CloudWatch logs read

### GitHub secrets
| Secret | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::709609992277:role/nanoclaw-github-deploy` |
| `ECR_REGISTRY` | `709609992277.dkr.ecr.ap-southeast-1.amazonaws.com` |
| `EC2_INSTANCE_ID` | `i-0f9cd20350cfdc1a6` |
| `HEALTH_URL` | `http://3.0.132.150:3000/health` |

### GitHub environments
- `staging` — auto-deploy on `staging` branch (optional; not currently used)
- `production` — manual approval, deploys on `main`
- `feature/nanoclaw-aws-deployment` is the active iterating branch and runs
  through `deploy-feature.yml` without a separate environment gate

---

## 9. Verification

```bash
# From local
curl http://3.0.132.150:3000/health

# From the EC2 (via SSM)
aws ssm start-session --target $(terraform output -raw ec2_instance_id)
sudo docker exec nanoclaw-orchestrator wget -qO- http://localhost:3000/health
```

Expected:
```json
{"status":"ok","uptime":...,"services":{"redis":"connected","dynamodb":"ok","opensearch":"ok"}}
```

Send a test WhatsApp message — watch the chain:
```bash
sudo docker logs -f nanoclaw-orchestrator   # orchestrator log
aws logs tail /ecs/nanoclaw-sub-agent --follow --region ap-southeast-1   # sub-agent log
```

You should see (orchestrator):
```
Inbound WhatsApp message ... fromMe=false
Routing message → queue:agent:shared:inbound
```

…and (sub-agent):
```
Bedrock invoke model=global.anthropic.claude-sonnet-4-5-20250929-v1:0
Response delivered to queue:orchestrator:responses
```

Plus, at the orchestrator, the response delivery:
```
Cloud response → wa.<...>:<thread> kind=chat
Message delivered id=... platformMsgId=...
```

---

## 10. Scaling

| Tier | Instance | vCPU | RAM | Concurrent users | ~Monthly |
|---|---|---|---|---|---|
| Starter (current) | t3.xlarge | 4 | 16 GB | 5–20 | $120 |
| | r6i.xlarge | 4 | 32 GB | 20–50 | $200 |
| | r6i.2xlarge | 8 | 64 GB | 50–100 | $400 |
| Heavy | r6i.4xlarge | 16 | 128 GB | 100–200 | $800 |

To scale up: edit `terraform.tfvars` (`instance_type = "r6i.xlarge"`) and
`terraform apply`. EC2 stop+restart causes ~2-3 min downtime; WhatsApp session
persists via S3.

To scale the sub-agent horizontally: `aws ecs update-service ... --desired-count 3`.
The shared queue (`queue:agent:shared:inbound`) means tasks share work via
BRPOP — no per-user routing needed.

---

## 11. Cost optimization

OpenSearch Serverless is the dominant fixed cost (~$350/mo for the 2-OCU
minimum). Alternatives:

- **Self-managed OpenSearch on the EC2** — eliminates the ~$350/mo at the
  cost of adding update + backup ops to the runbook
- **pgvector on RDS** — ~$15/mo on db.t3.micro; requires re-architecting the
  RAG pipeline because hybrid search support differs

EC2 Reserved Instance (1-year, no upfront): ~30% savings.
ElastiCache cache.t3.micro is free-tier eligible for 12 months on new accounts.
DynamoDB on-demand is fine; switch to provisioned only if you exceed ~$25/mo.

---

## 12. Teardown

```bash
cd infrastructure/terraform
terraform plan -destroy
terraform destroy
```

Removes everything including DynamoDB tables, S3 contents, OpenSearch
collection, Redis, EC2, ECS service, ECR images. Backup `nanoclaw-data-{account}`
S3 bucket and any DynamoDB tables you want to keep before running this.

To keep state, partial teardown:

```bash
terraform destroy -target=aws_instance.nanoclaw \
                  -target=aws_ecs_service.nanoclaw_sub_agent \
                  -target=aws_elasticache_replication_group.nanoclaw
```

---

## 13. Troubleshooting

### Orchestrator container won't start
```bash
sudo docker logs nanoclaw-orchestrator --tail 100
# common: Secrets Manager access denied (check EC2 IAM role)
# common: image not pulled (docker images | grep nanoclaw)
# common: port 3000 already bound (lsof -i :3000)
```

### "Access Denied" on AWS services
```bash
# Confirm the EC2 role
curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/

# Try the four core ops
aws dynamodb list-tables --region ap-southeast-1
aws s3 ls
aws bedrock list-foundation-models --region ap-southeast-1 \
  --query "modelSummaries[?contains(modelId,'sonnet-4-5')]"
aws secretsmanager get-secret-value --secret-id nanoclaw/app-config --region ap-southeast-1
```

### OpenSearch 403 (the canonical trap)
```bash
# Data-access policy
aws opensearchserverless list-access-policies --type data --region ap-southeast-1

# IAM action — this is the part everyone forgets
aws iam get-role-policy --role-name nanoclaw-ec2-role --policy-name aoss-api-access
# Look for "aoss:APIAccessAll"
```

### Bedrock `ValidationException ... on-demand throughput isn't supported`
You're calling `InvokeModel` against a bare model id. Use the inference-profile
id from `aws bedrock list-inference-profiles --region ap-southeast-1`
(`global.anthropic.claude-sonnet-4-5-...`).

### EC2 disk full → SSM dies → DNS dies
Classic symptom: `aws ssm send-command` returns `Status=Failed`,
`ResponseCode=1`, `ExecutionElapsedTime=PT0S`, no output. Console shows
"No space left on device" + "lookup ... connection refused".

Recovery (see `~/.hermes/skills/devops/aws-ec2-disk-full-recovery/SKILL.md`):
1. Expand the EBS volume in the AWS console
2. SSH via EC2 Instance Connect (SSM is dead)
3. `sudo growpart /dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1`
4. `sudo docker system prune -af` (NOT `--volumes` if you're using bind mounts)
5. Re-deploy via SSH directly — don't wait for GHA to rebuild

### WhatsApp session expired
The orchestrator log shows `Connection closed` or `Stream Errored`. Re-pair
through the admin dashboard QR. If the dashboard is also offline:
```bash
sudo docker exec nanoclaw-orchestrator rm -rf /app/sessions/baileys_auth_info
sudo docker restart nanoclaw-orchestrator
sudo docker logs -f nanoclaw-orchestrator   # watch for new QR
```

### ECS sub-agent won't roll
```bash
aws ecs describe-services --cluster nanoclaw-cluster --services nanoclaw-sub-agent \
  --region ap-southeast-1 \
  --query 'services[0].{primary:deployments[0].rolloutState,events:events[0:3]}'
```
Common causes: ECR image not yet pushed; task definition missing required env;
task role missing AOSS / DynamoDB / Bedrock permission.

### CloudWatch log destinations
```
/nanoclaw/orchestrator       orchestrator stdout/stderr
/ecs/nanoclaw-sub-agent      ECS Fargate sub-agent
/aws/lambda/<...>            (any future lambdas)
```

```bash
aws logs tail /ecs/nanoclaw-sub-agent --follow --region ap-southeast-1
aws logs tail /nanoclaw/orchestrator   --follow --region ap-southeast-1
```

### Emergency restart
```bash
# SSH onto EC2
aws ec2-instance-connect send-ssh-public-key --instance-id i-0f9cd20350cfdc1a6 \
  --instance-os-user ubuntu --availability-zone ap-southeast-1a \
  --ssh-public-key file://~/eic-key.pub
ssh -i ~/eic-key ubuntu@3.0.132.150

# Restart orchestrator
sudo docker restart nanoclaw-orchestrator

# Force-roll the sub-agent
aws ecs update-service --cluster nanoclaw-cluster --service nanoclaw-sub-agent \
  --force-new-deployment --region ap-southeast-1
```
