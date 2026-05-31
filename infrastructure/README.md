# Clawd / NanoClaw — AWS Infrastructure (Terraform)

Terraform for the Clawd / NanoClaw cloud deployment in `ap-southeast-1`.
This is the **source of truth** for the AWS resources backing
http://3.0.132.150:3000.

## Live state at a glance

- Account: `709609992277`
- Region: `ap-southeast-1` (Singapore — PDPA residency)
- Compute: EC2 **r6i.4xlarge** + ECS Fargate (1 task, 1 vCPU / 2 GB)
- LLM: AWS Bedrock — Claude Sonnet 4.5 / Haiku 4.5 / Cohere Embed Multilingual v3
- State stores: DynamoDB (4 tables) + S3 + OpenSearch Serverless + Redis

## Files

| File | Resources |
|---|---|
| `vpc.tf` | VPC, public + private subnets, NAT gateway, security groups |
| `ec2.tf` | EC2 instance, IAM role, instance profile, user-data |
| `ecs.tf` | `nanoclaw-cluster`, `nanoclaw-sub-agent` service + task def |
| `ecr.tf` | `nanoclaw/orchestrator`, `nanoclaw/agent` repositories |
| `dynamodb.tf` | 4 tables (chat-messages, user-preferences, webhook-tokens, system-errors) |
| `opensearch.tf` | Serverless `nanoclaw-documents` collection (VECTORSEARCH) |
| `redis.tf` | ElastiCache Redis cluster (`nanoclaw-redis-rg`) |
| `s3.tf` | `nanoclaw-data-{account}` bucket with lifecycle rules |
| `secrets.tf` | `nanoclaw/app-config`, `nanoclaw/google-secrets` placeholders |
| `iam.tf` | EC2 + ECS task roles (incl. `aoss:APIAccessAll` — required) |
| `cloudwatch.tf` | Log groups, alarms, SNS topic |
| `outputs.tf` | All resource identifiers |
| `user-data.sh.tpl` | EC2 bootstrap script |
| `terraform.tfvars.example` | Variable template |

## Prerequisites

```bash
aws configure                # region: ap-southeast-1
terraform --version          # >= 1.5
docker --version             # for image builds
```

Bedrock model access must be enabled in the AWS console for the three
inference profiles before `apply`:
- `global.anthropic.claude-sonnet-4-5-20250929-v1:0`
- `global.anthropic.claude-sonnet-4-5-20250929-v1:0`
- `cohere.embed-multilingual-v3`

```bash
aws bedrock list-inference-profiles --region ap-southeast-1
```

## Quick start (full stack)

```bash
cd infrastructure/terraform

cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars (project name, region, instance type)

terraform init
terraform plan
terraform apply              # ~5–10 minutes for full provisioning
```

After apply, see `docs/AWS-DEPLOYMENT.md` for image build, secrets
population, EC2 setup, ECS rollout, WhatsApp pairing.

## Outputs

```bash
terraform output
```

Key outputs (used by deployment scripts and CI):

| Output | Example |
|---|---|
| `ec2_instance_id` | `i-0f9cd20350cfdc1a6` |
| `ec2_public_ip` | `3.0.132.150` |
| `ecr_registry_url` | `709609992277.dkr.ecr.ap-southeast-1.amazonaws.com` |
| `redis_endpoint` | `nanoclaw-redis-rg.sipa0z.0001.apse1.cache.amazonaws.com:6379` |
| `opensearch_endpoint` | `https://66ik2p21jw225em9uj25.ap-southeast-1.aoss.amazonaws.com` |
| `s3_data_bucket` | `nanoclaw-data-709609992277` |

## Updates

```bash
terraform plan
terraform apply
```

Terraform state lives in S3 (configured in `versions.tf`); DO NOT keep it
local. State locking uses S3-native locking (`use_lockfile=true` in versions.tf); the old DynamoDB lock table `nanoclaw-terraform-locks` was destroyed and is no longer used. State bucket: `s3://nanoclaw-tfstate-709609992277`.

## Targeted updates

```bash
# Roll only EC2
terraform apply -target=aws_instance.nanoclaw

# Roll only ECS service
terraform apply -target=aws_ecs_service.nanoclaw_sub_agent

# Bump instance type only (no IAM / SG churn)
terraform apply -var="instance_type=r6i.xlarge" -target=aws_instance.nanoclaw
```

## Teardown

```bash
terraform destroy
```

Backup `nanoclaw-data-{account}` and any DynamoDB tables you want to keep
**before** running this. See `docs/disaster-recovery.md` for backup
procedures.

## Cost estimate (starter, low traffic)

| Service | ~Monthly |
|---|---|
| EC2 r6i.4xlarge | $120 |
| ECS Fargate (1 task) | $30 |
| ElastiCache cache.r6g.large | $12 |
| DynamoDB on-demand | $5 |
| OpenSearch Serverless (2 OCU min) | $350 |
| S3 (< 10 GB) | $1 |
| NAT Gateway | $32 |
| Secrets Manager | $1 |
| CloudWatch | $5 |
| Bedrock (variable) | $50 |
| **Total** | **≈ $610/mo** |

OpenSearch Serverless is the dominant fixed cost. Self-managed OpenSearch on
the EC2 cuts ~$350/mo at the cost of operational burden.

## Common gotchas

- **`aoss:APIAccessAll` is required** on both the EC2 instance role and the
  ECS task role; missing it returns an opaque 403 from OpenSearch
- Bedrock requires inference-profile IDs (`global.` / `apac.` prefix), not
  bare model IDs
- Cohere Embed Multilingual v3 is the embedding default in apse1 because Titan v2 is
  not GA there; the Python pipeline auto-selects by region
- Sub-agent task gets `BEDROCK_LLM_MODEL_ID` injected from
  `nanoclaw/app-config:llm_subagent_model_id` at task launch via
  `src/cloud/container-manager/lifecycle.ts`

## Related docs

- `docs/AWS-DEPLOYMENT.md` — full deploy procedure
- `docs/architecture.md` — system architecture and data flows
- `docs/aws-resource-inventory.md` — live resource snapshot
- `docs/SECURITY.md` — security controls
- `docs/disaster-recovery.md` — RTO/RPO and recovery runbooks
