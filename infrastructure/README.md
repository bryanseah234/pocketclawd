# Infrastructure (Terraform)

All AWS resources for Clawd are managed by Terraform in infrastructure/terraform/.

## State

S3 bucket: nanoclaw-tfstate-709609992277
S3-native locking (use_lockfile=true). No DynamoDB lock table.

## Resources managed

- EC2 instance (orchestrator)
- ECS cluster, service, task definition (sub-agent)
- ECR repositories (nanoclaw/orchestrator, nanoclaw/agent)
- DynamoDB tables (4x nanoclaw-*)
- S3 bucket (nanoclaw-data-709609992277, versioning enabled)
- OpenSearch Serverless collection (nanoclaw-documents)
- ElastiCache Redis cluster (nanoclaw-redis, 7.1.0)
- Secrets Manager secret (nanoclaw/app-config)
- IAM roles and policies (ECS task role, EC2 instance role)
- VPC, subnets, security groups, NAT gateway
- CloudWatch log groups

## Usage

```bash
cd infrastructure/terraform

# Init (first time or after backend change)
terraform init

# Plan
terraform plan -out=tfplan

# Apply
terraform apply tfplan

# Destroy (careful -- deletes everything)
terraform destroy
```

Use --profile clawd-prod for all AWS CLI operations.
The Terraform provider picks up the profile from AWS_PROFILE env var
or the provider config in main.tf.

## Runbooks

- Blue/green deploy: infrastructure/terraform/BLUE-GREEN-RUNBOOK.md
- Redis cutover: infrastructure/terraform/REDIS-CUTOVER.md
