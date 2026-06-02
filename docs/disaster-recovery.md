# Disaster Recovery

## ECS sub-agent total failure

Symptoms: no responses from WhatsApp / Telegram. ECS shows 0 running tasks.

```bash
# Check service state
aws ecs describe-services   --cluster nanoclaw-cluster --services nanoclaw-sub-agent   --profile clawd-prod --region ap-southeast-1   --query 'services[0].{running:runningCount,pending:pendingCount,events:events[0:3]}'

# Check logs for crash reason
aws logs tail /ecs/nanoclaw-sub-agent   --profile clawd-prod --region ap-southeast-1 --since 30m

# Force new deployment (picks up latest image)
aws ecs update-service   --cluster nanoclaw-cluster --service nanoclaw-sub-agent   --force-new-deployment   --profile clawd-prod --region ap-southeast-1
```

If new tasks crash on start, roll back to previous task definition revision:
see docs/ci-cd.md rollback section.

## EC2 orchestrator down

Symptoms: WhatsApp / Telegram bots offline. EC2 instance unreachable.

```bash
# Check instance state
aws ec2 describe-instances   --instance-ids i-0f9cd20350cfdc1a6   --profile clawd-prod --region ap-southeast-1   --query 'Reservations[0].Instances[0].State.Name'

# Start if stopped
aws ec2 start-instances   --instance-ids i-0f9cd20350cfdc1a6   --profile clawd-prod --region ap-southeast-1

# Connect via SSM (no SSH key needed)
aws ssm start-session   --target i-0f9cd20350cfdc1a6   --profile clawd-prod --region ap-southeast-1

# On EC2: check and restart service
sudo systemctl status nanoclaw
sudo journalctl -u nanoclaw -n 50 --no-pager
sudo systemctl restart nanoclaw
```

If the instance is unrecoverable, provision a new one from the AMI and
run the orchestrator bootstrap from infrastructure/terraform/.

## Redis failure

Symptoms: all requests fail with connection errors. Queues empty.

ElastiCache Redis is a managed cluster. AWS handles automatic failover for
Multi-AZ deployments. If the endpoint is unreachable:

```bash
# Check cluster state
aws elasticache describe-cache-clusters   --cache-cluster-id nanoclaw-redis   --profile clawd-prod --region ap-southeast-1   --query 'CacheClusters[0].{status:CacheClusterStatus,endpoint:RedisConfiguration}'
```

If the cluster is in failed state, raise an AWS support ticket.
In the meantime, sub-agent tasks will backpressure and retry via the DLQ.

## DynamoDB table deleted or corrupted

DynamoDB point-in-time recovery (PITR) is enabled on all nanoclaw-* tables.
Restore from PITR:

```bash
aws dynamodb restore-table-to-point-in-time   --source-table-name nanoclaw-chat-messages   --target-table-name nanoclaw-chat-messages-restore   --use-latest-restorable-time   --profile clawd-prod --region ap-southeast-1
```

Rename (swap) tables via Terraform after restore is complete.

## S3 data loss

S3 bucket nanoclaw-data-709609992277 has versioning enabled.
Recover a deleted object:

```bash
# List versions
aws s3api list-object-versions   --bucket nanoclaw-data-709609992277   --prefix media/generated/YOUR-FILE.pdf   --profile clawd-prod --region ap-southeast-1

# Restore by removing the delete marker
aws s3api delete-object   --bucket nanoclaw-data-709609992277   --key media/generated/YOUR-FILE.pdf   --version-id <DELETE_MARKER_VERSION_ID>   --profile clawd-prod --region ap-southeast-1
```

## OpenSearch Serverless degraded

Symptoms: RAG responses empty, slow, or error. Context missing from replies.

AOSS is fully managed -- no manual restart option. If the collection endpoint
is unreachable, the sub-agent falls back to LLM-only responses (no RAG context).
Users will still get replies, just without personal knowledge base context.

Check AOSS health in AWS console -> OpenSearch -> Serverless -> nanoclaw-documents.

## Full system rebuild from Terraform

If all resources need to be rebuilt from scratch:

```bash
cd infrastructure/terraform
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Then:
1. Push latest code to trigger CI/CD (ECS image push + service deploy)
2. SSH to new EC2, run orchestrator bootstrap
3. Restore DynamoDB from PITR if data recovery is needed

## Queue drain after an outage

Messages that arrived during downtime sit in the Redis queues.
They will be processed in order once services come back up.
If the queue has grown very large, check DLQ length and clear stale entries:

```bash
# Check queue depths via SSM on EC2
aws ssm send-command   --instance-ids i-0f9cd20350cfdc1a6   --document-name AWS-RunShellScript   --parameters commands='["redis-cli -u $REDIS_URL llen queue:agent:dispatch"]'   --profile clawd-prod --region ap-southeast-1
```
