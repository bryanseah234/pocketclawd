# NanoClaw AWS Deployment Guide

Complete admin procedure to bring NanoClaw (multi-user WhatsApp AI assistant) live on AWS.

**Architecture**: Single EC2 instance (r6i.4xlarge) in `ap-southeast-1` running a Node.js orchestrator + per-user Docker containers (FastAPI sub-agents). Managed services: DynamoDB, OpenSearch Serverless, S3, ElastiCache Redis, Bedrock (Claude), Secrets Manager, CloudWatch, ECR.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Infrastructure Deployment](#2-infrastructure-deployment)
3. [Secrets Configuration](#3-secrets-configuration)
4. [Docker Images](#4-docker-images)
5. [EC2 Instance Setup](#5-ec2-instance-setup)
6. [WhatsApp Pairing](#6-whatsapp-pairing)
7. [CI/CD Setup](#7-cicd-setup)
8. [Verification](#8-verification)
9. [Scaling](#9-scaling)
10. [Cost Optimization Tips](#10-cost-optimization-tips)
11. [Teardown](#11-teardown)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Prerequisites

### AWS Account

- An AWS account with billing enabled
- IAM user or role with `AdministratorAccess` (or scoped to EC2, VPC, DynamoDB, S3, ElastiCache, OpenSearch, ECR, Secrets Manager, CloudWatch, Bedrock, IAM, SSM)
- Bedrock model access enabled for `anthropic.claude-3-5-sonnet-20241022-v2:0` in `ap-southeast-1` (request via AWS Console → Bedrock → Model access)

### Local tools

```bash
# AWS CLI v2
aws --version   # >= 2.x
aws configure   # Region: ap-southeast-1

# Terraform >= 1.5.0
terraform --version

# Docker (for local image builds)
docker --version

# Node.js 20 + pnpm (for orchestrator build)
node --version   # >= 20
pnpm --version   # >= 10
```

### Install Terraform (if missing)

```bash
# macOS
brew install terraform

# Ubuntu/Debian
sudo apt-get install -y gnupg software-properties-common
wget -O- https://apt.releases.hashicorp.com/gpg | gpg --dearmor | sudo tee /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt-get update && sudo apt-get install terraform

# Windows
winget install Hashicorp.Terraform
```

### EC2 Key Pair

Create in `ap-southeast-1` before running Terraform:

```bash
aws ec2 create-key-pair \
  --key-name nanoclaw-key \
  --region ap-southeast-1 \
  --query 'KeyMaterial' \
  --output text > nanoclaw-key.pem

chmod 400 nanoclaw-key.pem
```

---

## 2. Infrastructure Deployment

### Configure variables

```bash
cd infrastructure/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
key_pair_name   = "nanoclaw-key"
admin_ssh_cidrs = ["YOUR_IP/32"]       # curl ifconfig.me
admin_https_cidrs = ["0.0.0.0/0"]      # or restrict to your IP
instance_type   = "r6i.4xlarge"        # production (16 vCPU, 128 GB)
redis_node_type = "cache.t3.micro"     # start small
environment     = "production"
aws_region      = "ap-southeast-1"
```

> For initial testing, use `instance_type = "t3.xlarge"` (~$120/mo) and scale up later.

### Deploy

```bash
# Initialize providers and modules
terraform init

# Preview what will be created
terraform plan

# Deploy (~5-10 minutes)
terraform apply
```

### Capture outputs

```bash
# Print all outputs (instance ID, endpoints, bucket names, ECR URLs)
terraform output

# Save for reference
terraform output -json > ../terraform-outputs.json
```

Key outputs you'll need:

| Output | Used for |
| ------ | -------- |
| `ec2_instance_id` | SSM sessions, CI/CD |
| `ecr_orchestrator_url` | Docker push target |
| `ecr_agent_url` | Docker push target |
| `redis_endpoint` | Secrets Manager config |
| `opensearch_endpoint` | Secrets Manager config |
| `s3_data_bucket` | Secrets Manager config |
| `dynamodb_table_names` | Secrets Manager config |

---

## 3. Secrets Configuration

After `terraform apply`, populate the Secrets Manager secret with actual endpoint values from terraform outputs.

### Update the secret

```bash
aws secretsmanager put-secret-value \
  --secret-id nanoclaw/app-config \
  --region ap-southeast-1 \
  --secret-string '{
    "redis_host": "'$(terraform output -raw redis_endpoint)'",
    "redis_port": 6379,
    "redis_password": "'$(terraform output -raw redis_auth_token)'",
    "redis_tls": true,
    "dynamodb_chat_messages_table": "nanoclaw-chat-messages",
    "dynamodb_webhook_tokens_table": "nanoclaw-webhook-tokens",
    "dynamodb_user_preferences_table": "nanoclaw-user-preferences",
    "dynamodb_system_errors_table": "nanoclaw-system-errors",
    "opensearch_endpoint": "'$(terraform output -raw opensearch_endpoint)'",
    "opensearch_index_name": "documents",
    "s3_data_bucket": "'$(terraform output -raw s3_data_bucket)'",
    "llm_model_id": "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "ecr_registry_url": "'$(terraform output -raw ecr_registry_url)'",
    "ecr_agent_image": "nanoclaw/agent:latest"
  }'
```

### Verify

```bash
aws secretsmanager get-secret-value \
  --secret-id nanoclaw/app-config \
  --region ap-southeast-1 \
  --query SecretString \
  --output text | jq .
```

---

## 4. Docker Images

### Build locally and push to ECR

```bash
# Authenticate Docker to ECR
ECR_REGISTRY=$(terraform output -raw ecr_registry_url)
aws ecr get-login-password --region ap-southeast-1 | \
  docker login --username AWS --password-stdin "$ECR_REGISTRY"

# Build orchestrator (Node 20 Alpine, multi-stage)
docker build -f Dockerfile.orchestrator -t "$ECR_REGISTRY/nanoclaw/orchestrator:latest" .

# Build sub-agent (Python 3.11 slim)
docker build -f container/sub-agent/Dockerfile -t "$ECR_REGISTRY/nanoclaw/agent:latest" .

# Push both
docker push "$ECR_REGISTRY/nanoclaw/orchestrator:latest"
docker push "$ECR_REGISTRY/nanoclaw/agent:latest"
```

### Verify images in ECR

```bash
aws ecr describe-images --repository-name nanoclaw/orchestrator --region ap-southeast-1
aws ecr describe-images --repository-name nanoclaw/agent --region ap-southeast-1
```

---

## 5. EC2 Instance Setup

The EC2 instance is provisioned by Terraform with a user-data script that installs Docker, Node.js, and the SSM agent. After first boot, connect and finalize setup.

### Connect via SSM (preferred — no SSH key needed)

```bash
aws ssm start-session --target $(terraform output -raw ec2_instance_id)
```

### Connect via SSH (if in public subnet or via bastion)

```bash
ssh -i nanoclaw-key.pem ubuntu@$(terraform output -raw ec2_private_ip)
```

### Verify Docker and pull images

```bash
# On the EC2 instance:
docker --version
docker info | grep "Docker Root Dir"

# Pull images from ECR
ECR_REGISTRY="<account-id>.dkr.ecr.ap-southeast-1.amazonaws.com"
aws ecr get-login-password --region ap-southeast-1 | \
  docker login --username AWS --password-stdin "$ECR_REGISTRY"

docker pull "$ECR_REGISTRY/nanoclaw/orchestrator:latest"
docker pull "$ECR_REGISTRY/nanoclaw/agent:latest"

# Tag for local use
docker tag "$ECR_REGISTRY/nanoclaw/orchestrator:latest" nanoclaw-orchestrator:current
docker tag "$ECR_REGISTRY/nanoclaw/agent:latest" nanoclaw-agent:current
```

### Configure the systemd service

The user-data script creates `/etc/systemd/system/nanoclaw-orchestrator.service`. Verify it exists:

```bash
cat /etc/systemd/system/nanoclaw-orchestrator.service
```

Expected content (created by Terraform user-data):

```ini
[Unit]
Description=NanoClaw Orchestrator
After=docker.service
Requires=docker.service

[Service]
Type=simple
Restart=always
RestartSec=10
Environment=NANOCLAW_ENV=cloud
Environment=AWS_REGION=ap-southeast-1
ExecStart=/usr/bin/docker run --rm \
  --name nanoclaw-orchestrator \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e NANOCLAW_ENV=cloud \
  -e AWS_REGION=ap-southeast-1 \
  nanoclaw-orchestrator:current
ExecStop=/usr/bin/docker stop nanoclaw-orchestrator

[Install]
WantedBy=multi-user.target
```

### Start the service

```bash
sudo systemctl daemon-reload
sudo systemctl enable nanoclaw-orchestrator
sudo systemctl start nanoclaw-orchestrator

# Check status
sudo systemctl status nanoclaw-orchestrator

# Follow logs
sudo journalctl -u nanoclaw-orchestrator -f
```

### Environment variable

The critical env var is `NANOCLAW_ENV=cloud` — this activates cloud mode in `src/cloud/bootstrap.ts`, which switches all storage backends from local to AWS managed services (DynamoDB, S3, OpenSearch, Redis, Bedrock).

---

## 6. WhatsApp Pairing

NanoClaw uses Baileys (unofficial WhatsApp Web API) which requires a QR code pairing flow on first connection.

### Start the pairing session

```bash
# Connect to the instance
aws ssm start-session --target $(terraform output -raw ec2_instance_id)

# Watch orchestrator logs for the QR code
sudo journalctl -u nanoclaw-orchestrator -f
```

On first start, the orchestrator logs will output a QR code in the terminal (ASCII art).

### Scan the QR code

1. Open WhatsApp on your phone
2. Go to **Settings → Linked Devices → Link a Device**
3. Scan the QR code from the terminal output

The session persists across restarts (stored in the container volume). You only need to re-pair if:

- The session is explicitly logged out from the phone
- The session file is deleted
- WhatsApp invalidates the session (rare, ~every 14 days of inactivity)

### Verify pairing

After scanning, the logs should show:

```text
[baileys] Connection open
[baileys] Session authenticated for <phone-number>
```

Send a test message to the WhatsApp number — you should see it appear in the orchestrator logs.

---

## 7. CI/CD Setup

The deploy pipeline (`.github/workflows/deploy.yml`) uses GitHub OIDC to assume an AWS IAM role — no long-lived credentials stored in GitHub.

### Create the OIDC identity provider in AWS

```bash
# One-time setup: register GitHub as an OIDC provider
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

### Create the deploy IAM role

Create a role with trust policy for your GitHub repo:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPO>:ref:refs/heads/*"
        }
      }
    }
  ]
}
```

Attach policies: `AmazonEC2ContainerRegistryPowerUser`, `AmazonSSMFullAccess`, `AmazonSSMReadOnlyAccess` (or a scoped custom policy).

### Configure GitHub repository secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
| ------ | ----- |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<account-id>:role/nanoclaw-github-deploy` |
| `ECR_REGISTRY` | `<account-id>.dkr.ecr.ap-southeast-1.amazonaws.com` |
| `STAGING_INSTANCE_ID` | EC2 instance ID for staging (from `terraform output`) |
| `PRODUCTION_INSTANCE_ID` | EC2 instance ID for production (from `terraform output`) |
| `STAGING_HEALTH_URL` | `http://<staging-private-ip>:3000` (or internal ALB URL) |
| `PRODUCTION_HEALTH_URL` | `http://<production-private-ip>:3000` (or internal ALB URL) |

### Configure GitHub environments

Create two environments in **Settings → Environments**:

- **staging** — auto-deploy on push to `staging` branch
- **production** — requires manual approval, deploys on push to `main`

### Pipeline flow

```text
push to main/staging
  → lint → typecheck → test (80% coverage gate) → tfsec security scan
  → build orchestrator + agent images → push to ECR
  → deploy to staging via SSM → smoke test (health endpoint)
  → [main only] deploy to production → health check with auto-rollback
```

Rollback is automatic: if the production health check fails after 10 minutes, the pipeline reverts to the previous image tag stored in SSM Parameter Store.

---

## 8. Verification

### Health check

```bash
# From the EC2 instance
curl http://localhost:3000/health

# Expected response:
# {"status":"ok","version":"...","uptime":...,"services":{"redis":"connected","dynamodb":"ok","opensearch":"ok"}}
```

### From your local machine (via SSM port forwarding)

```bash
aws ssm start-session \
  --target $(terraform output -raw ec2_instance_id) \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}'

# In another terminal:
curl http://localhost:3000/health
```

### Send a test message

1. Send any message to the paired WhatsApp number
2. Watch the logs:

```bash
aws ssm start-session --target $(terraform output -raw ec2_instance_id)
sudo journalctl -u nanoclaw-orchestrator -f --since "1 min ago"
```

You should see the full message chain:

```text
Inbound WhatsApp message ... fromMe=false
Message routed sessionId=... agentGroup=... wake=true
[container] Starting sub-agent container for user ...
[bedrock] Invoking anthropic.claude-3-5-sonnet-20241022-v2:0
Message delivered id=... platformMsgId=...
```

### Verify AWS service connectivity

```bash
# DynamoDB
aws dynamodb describe-table --table-name nanoclaw-chat-messages --region ap-southeast-1

# S3
aws s3 ls s3://$(terraform output -raw s3_data_bucket)/

# OpenSearch (from EC2 instance)
curl -XGET "$(terraform output -raw opensearch_endpoint)/documents/_count"

# Redis (from EC2 instance)
redis-cli -h $(terraform output -raw redis_endpoint) --tls -a <auth-token> ping
```

---

## 9. Scaling

NanoClaw uses a vertical scaling path. The single-instance architecture simplifies operations while supporting 50-100 concurrent users.

### Instance type progression

| Instance | vCPU | RAM | Users | Monthly cost |
| -------- | ---- | --- | ----- | ------------ |
| t3.xlarge | 4 | 16 GB | 5-20 | ~$120 |
| r6i.xlarge | 4 | 32 GB | 20-50 | ~$200 |
| r6i.4xlarge | 16 | 128 GB | 50-100 | ~$800 |
| r6i.8xlarge | 32 | 256 GB | 100-200 | ~$1,600 |

### Scale up procedure

1. Edit `terraform.tfvars`:

```hcl
instance_type = "r6i.4xlarge"
```

2. Apply:

```bash
terraform apply
```

> This will stop and restart the EC2 instance. Downtime: ~2-3 minutes. WhatsApp session persists if stored on an EBS volume.

### Scale Redis

```hcl
redis_node_type = "cache.r6g.large"
```

Then `terraform apply`. ElastiCache handles the migration automatically (brief connectivity blip).

### When to scale

Monitor these CloudWatch metrics:

- **CPU > 70% sustained** → scale instance type
- **Memory > 80%** → scale instance type (more containers need more RAM)
- **Redis connections > 1000** → scale Redis node type
- **DynamoDB throttled reads/writes** → already on-demand, check hot partitions

---

## 10. Cost Optimization Tips

### Estimated monthly cost (starter)

| Service | Cost |
| ------- | ---- |
| EC2 t3.xlarge | ~$120 |
| ElastiCache cache.t3.micro | ~$12 |
| DynamoDB on-demand | ~$5 |
| OpenSearch Serverless (2 OCU min) | ~$350 |
| S3 (< 10 GB) | ~$1 |
| NAT Gateway | ~$32 |
| Secrets Manager | ~$1 |
| CloudWatch | ~$5 |
| **Total** | **~$526/mo** |

### Reduce OpenSearch cost (biggest savings)

OpenSearch Serverless has a minimum of 2 OCUs at $0.24/hr each = ~$350/mo regardless of usage. Alternatives:

- **Self-managed OpenSearch on EC2** — run a single-node OpenSearch container on the same instance. Cost: $0 extra (uses existing EC2 RAM). Trade-off: you manage updates and backups.
- **pgvector on RDS** — if you add a Postgres RDS instance for other reasons, use pgvector for embeddings. Drops vector search cost to ~$15/mo (db.t3.micro).
- **Pinecone free tier** — 1 index, 100k vectors. Good for development/low-traffic.

Switching from OpenSearch Serverless to self-managed drops total cost to ~$176/mo.

### Reserved Instances / Savings Plans

- **EC2 Reserved Instance (1-year, no upfront)**: ~30% savings on compute
- **EC2 Reserved Instance (3-year, all upfront)**: ~55% savings
- **Compute Savings Plan**: flexible across instance families, ~20-30% savings

### Other tips

- **NAT Gateway** ($32/mo): If the EC2 instance only needs outbound internet for WhatsApp + Bedrock, consider placing it in a public subnet with a security group instead. Saves $32/mo but reduces network isolation.
- **ElastiCache**: `cache.t3.micro` is free-tier eligible for 12 months on new accounts.
- **DynamoDB**: On-demand pricing is cheapest at low traffic. Switch to provisioned capacity only if you exceed ~$25/mo in on-demand costs.
- **CloudWatch Logs**: Set retention to 14 or 30 days to avoid unbounded log storage costs.
- **ECR lifecycle policies**: Already configured by Terraform to keep only the last 10 images per repository.

---

## 11. Teardown

### Destroy all infrastructure

```bash
cd infrastructure/terraform

# Preview what will be destroyed
terraform plan -destroy

# Destroy everything
terraform destroy
```

> **Warning**: This permanently deletes ALL resources including:
>
> - DynamoDB tables (point-in-time recovery enabled, but data is lost after destroy)
> - S3 bucket and all objects
> - OpenSearch collection and all indexed documents
> - Redis data
> - EC2 instance and EBS volumes
> - ECR repositories and all images

### Partial teardown (keep data)

To remove compute but keep data stores:

```bash
# Remove only the EC2 instance
terraform destroy -target=aws_instance.nanoclaw

# Remove EC2 + Redis (keep DynamoDB, S3, OpenSearch)
terraform destroy -target=aws_instance.nanoclaw -target=aws_elasticache_replication_group.nanoclaw
```

### Clean up GitHub secrets

After teardown, remove the repository secrets (`AWS_DEPLOY_ROLE_ARN`, `ECR_REGISTRY`, etc.) and delete the OIDC provider if no longer needed:

```bash
aws iam delete-open-id-connect-provider \
  --open-id-connect-provider-arn arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com
```

---

## 12. Troubleshooting

### Orchestrator won't start

```bash
# Check systemd status
sudo systemctl status nanoclaw-orchestrator

# Check Docker container logs
sudo docker logs nanoclaw-orchestrator --tail 100

# Common causes:
# - Image not pulled: docker images | grep nanoclaw
# - Secrets Manager access denied: check EC2 IAM role
# - Redis connection refused: check security group allows port 6379 from EC2
```

### "Access Denied" on AWS services

The EC2 instance role needs policies for DynamoDB, S3, OpenSearch, Bedrock, Secrets Manager, ECR, and CloudWatch. Verify:

```bash
# On the EC2 instance — check what role is attached
curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/

# Test DynamoDB access
aws dynamodb list-tables --region ap-southeast-1

# Test Secrets Manager access
aws secretsmanager get-secret-value --secret-id nanoclaw/app-config --region ap-southeast-1
```

### Redis connection failures

```bash
# From EC2 instance — test connectivity
redis-cli -h <redis-endpoint> --tls -p 6379 -a <auth-token> ping

# If "Connection refused":
# 1. Check security group allows EC2 → Redis on port 6379
# 2. Check Redis subnet group includes the EC2 subnet
# 3. Check redis_tls matches your ElastiCache encryption-in-transit setting
```

### OpenSearch "403 Forbidden"

OpenSearch Serverless uses data access policies. The EC2 instance role must be listed in the collection's data access policy:

```bash
aws opensearchserverless list-access-policies --type data --region ap-southeast-1
```

### Bedrock "AccessDeniedException"

```bash
# Verify model access is enabled
aws bedrock list-foundation-models --region ap-southeast-1 \
  --query "modelSummaries[?modelId=='anthropic.claude-3-5-sonnet-20241022-v2:0']"

# If empty: go to AWS Console → Bedrock → Model access → Request access for Claude
```

### WhatsApp session expired

If the bot stops receiving messages:

1. Check logs for `[baileys] Connection closed` or `Stream Errored`
2. The session may need re-pairing:

```bash
# Remove stale session data (path depends on your volume mount)
sudo docker exec nanoclaw-orchestrator rm -rf /app/sessions/baileys_auth_info

# Restart to trigger new QR code
sudo systemctl restart nanoclaw-orchestrator

# Watch logs for QR code
sudo journalctl -u nanoclaw-orchestrator -f
```

### Sub-agent containers not starting

```bash
# Check Docker can pull the agent image
docker images | grep nanoclaw/agent

# Check Docker socket is mounted
docker inspect nanoclaw-orchestrator | jq '.[0].Mounts'

# Check available disk space (containers need room)
df -h /var/lib/docker

# Check container limits
docker ps -a | grep sub-agent
docker logs <container-id>
```

### CI/CD pipeline failures

| Failure point | Fix |
| ------------- | --- |
| OIDC auth fails | Verify trust policy `sub` matches your repo path exactly |
| ECR push denied | Check `AmazonEC2ContainerRegistryPowerUser` on deploy role |
| SSM command fails | Verify instance is running and SSM agent is healthy |
| Health check timeout | Check security group allows health check source → port 3000 |
| Rollback triggered | Check CloudWatch logs for the crash reason before the rollback |

### CloudWatch log locations

```bash
# Log group names (created by Terraform)
/nanoclaw/orchestrator     # orchestrator stdout/stderr
/nanoclaw/sub-agents       # per-user container logs
/nanoclaw/system           # systemd + Docker daemon

# Quick tail from your local machine
aws logs tail /nanoclaw/orchestrator --follow --region ap-southeast-1
```

### Emergency restart

```bash
# Nuclear option: stop everything, pull fresh images, restart
aws ssm start-session --target <instance-id>

sudo systemctl stop nanoclaw-orchestrator
docker stop $(docker ps -q)
docker system prune -f

ECR="<account-id>.dkr.ecr.ap-southeast-1.amazonaws.com"
aws ecr get-login-password --region ap-southeast-1 | docker login --username AWS --password-stdin "$ECR"
docker pull "$ECR/nanoclaw/orchestrator:latest"
docker pull "$ECR/nanoclaw/agent:latest"
docker tag "$ECR/nanoclaw/orchestrator:latest" nanoclaw-orchestrator:current
docker tag "$ECR/nanoclaw/agent:latest" nanoclaw-agent:current

sudo systemctl start nanoclaw-orchestrator
```
