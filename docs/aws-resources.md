# AWS Resource Inventory

Account 709609992277, region ap-southeast-1.
All runtime config is read from Secrets Manager nanoclaw/app-config at boot.

## Compute

| Resource | ID / Name | Notes |
|---|---|---|
| EC2 instance | i-0f9cd20350cfdc1a6 | Orchestrator, Node.js port 3000 |
| ECS cluster | nanoclaw-cluster | Fargate |
| ECS service | nanoclaw-sub-agent | 2 tasks, rolling update |
| ECR repo (orchestrator) | nanoclaw/orchestrator | latest + SHA tags |
| ECR repo (sub-agent) | nanoclaw/agent | latest + SHA tags |

## Storage

| Resource | Name | Notes |
|---|---|---|
| DynamoDB | nanoclaw-chat-messages | Chat history, TTL on messages |
| DynamoDB | nanoclaw-user-preferences | Onboarding state, profile, digest prefs |
| DynamoDB | nanoclaw-system-errors | Error / audit log |
| DynamoDB | nanoclaw-webhook-tokens | Scheduled message tokens |
| S3 | nanoclaw-data-709609992277 | Documents, generated media (prefix media/generated/) |
| OpenSearch Serverless | nanoclaw-documents | Per-user vector + BM25 chunks |
| ElastiCache Redis | nanoclaw-redis (7.1.0) | Queues, rate limits, reminders, cache |

## Networking

| Resource | Details |
|---|---|
| Redis endpoint | nanoclaw-redis.sipa0z.0001.apse1.cache.amazonaws.com:6379 |
| EC2 security group | Port 3000 open (admin). Port 443 pending C9. |
| ECS tasks | No public IP, NAT gateway for outbound |

## Secrets / config

| Resource | Name |
|---|---|
| Secrets Manager | nanoclaw/app-config |

## Terraform state

S3 bucket: nanoclaw-tfstate-709609992277
S3-native locking (use_lockfile=true).
Do not re-add a DynamoDB lock table -- it was intentionally removed.

## IAM

| Entity | Notes |
|---|---|
| IAM user BedrockAPIKey-1gi8 | Admin via Terraform group. Key expires -- rotate before expiry. |
| ECS task role | DynamoDB, S3, AOSS, Bedrock, Secrets Manager |
| EC2 instance role | Same scope + SSM |
