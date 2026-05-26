# NanoClaw AWS Infrastructure

Terraform configuration for deploying NanoClaw WhatsApp Assistant to AWS.

## Architecture

- **EC2** (t3.xlarge) — Orchestrator + rootless Docker containers
- **DynamoDB** — Chat history, user preferences, webhook tokens, system errors
- **OpenSearch Serverless** — Vector search for RAG pipeline
- **S3** — Document storage, session persistence, generated files
- **ElastiCache Redis** — Message queue between orchestrator and sub-agents
- **Secrets Manager** — All credentials with rotation
- **CloudWatch** — Logs, metrics, alerts
- **ECR** — Container image registry

## Prerequisites

1. **AWS CLI** configured with credentials:

   ```bash
   aws configure
   # Region: ap-southeast-1
   ```

2. **Terraform** >= 1.5.0:

   ```bash
   # Windows (winget)
   winget install Hashicorp.Terraform

   # macOS
   brew install terraform

   # Linux
   sudo apt-get install terraform
   ```

3. **EC2 Key Pair** created in ap-southeast-1:

   ```bash
   aws ec2 create-key-pair --key-name nanoclaw-key --region ap-southeast-1 \
     --query 'KeyMaterial' --output text > nanoclaw-key.pem
   chmod 400 nanoclaw-key.pem
   ```

## Quick Start

```bash
cd infrastructure/terraform

# Copy and edit variables
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

# Initialize Terraform
terraform init

# Preview changes
terraform plan

# Deploy (takes ~5-10 minutes)
terraform apply

# View outputs (endpoints, IPs, bucket names)
terraform output
```

## Estimated Monthly Cost (t3.xlarge starter)

| Service | Estimated Cost |
|---------|---------------|
| EC2 t3.xlarge (on-demand) | ~$120 |
| ElastiCache cache.t3.micro | ~$12 |
| DynamoDB (on-demand, low traffic) | ~$5 |
| OpenSearch Serverless (2 OCU min) | ~$350 |
| S3 (< 10 GB) | ~$1 |
| NAT Gateway | ~$32 |
| Secrets Manager | ~$1 |
| CloudWatch | ~$5 |
| **Total** | **~$526/mo** |

> **Note:** OpenSearch Serverless has a minimum of 2 OCUs ($0.24/hr each). For development, consider using a self-managed OpenSearch on the EC2 instance instead, or use pgvector on RDS to reduce costs to ~$176/mo.

## Scaling Up

Change one variable in `terraform.tfvars`:

```hcl
# Scale compute
instance_type = "r6i.4xlarge"  # 16 vCPU, 128 GB RAM

# Scale Redis
redis_node_type = "cache.r6g.large"
```

Then: `terraform apply`

## Connecting to the Instance

```bash
# Via SSM (no SSH key needed, goes through private subnet)
aws ssm start-session --target $(terraform output -raw ec2_instance_id)

# Via SSH (requires bastion or VPN in private subnet)
ssh -i nanoclaw-key.pem ubuntu@$(terraform output -raw ec2_private_ip)
```

## Destroying Infrastructure

```bash
terraform destroy
```

> ⚠️ This deletes ALL resources including data. DynamoDB tables have point-in-time recovery enabled, but S3 objects and OpenSearch data will be permanently lost.

## File Structure

```
infrastructure/terraform/
├── versions.tf          # Provider config, backend
├── variables.tf         # All input variables
├── vpc.tf              # VPC, subnets, security groups, VPC endpoints
├── ec2.tf              # EC2 instance, IAM role + policies
├── dynamodb.tf         # 4 DynamoDB tables with TTL
├── s3.tf               # S3 bucket with lifecycle rules
├── redis.tf            # ElastiCache Redis cluster
├── opensearch.tf       # OpenSearch Serverless collection
├── ecr.tf              # ECR repositories + lifecycle policies
├── secrets.tf          # Secrets Manager entries
├── cloudwatch.tf       # Log groups, alarms, SNS topic
├── outputs.tf          # All resource identifiers
├── user-data.sh.tpl    # EC2 bootstrap script
└── terraform.tfvars.example
```
