# NanoClaw Disaster Recovery Runbook

## RTO / RPO Targets
- **RTO**: 30 minutes
- **RPO**: 5 minutes (DynamoDB PITR, S3 versioned; Redis is ephemeral — messages in-flight are best-effort)

## Architecture Overview
| Component | AWS Service | Identifier |
|-----------|-------------|------------|
| Orchestrator | EC2 r6i.4xlarge | i-0f9cd20350cfdc1a6 |
| Container runtime | Docker (on EC2) | — |
| Chat storage | DynamoDB | nanoclaw-chat-messages |
| User preferences | DynamoDB | nanoclaw-user-preferences |
| System errors | DynamoDB | nanoclaw-system-errors |
| Webhook tokens | DynamoDB | nanoclaw-webhook-tokens |
| File storage | S3 | nanoclaw-data-709609992277 |
| Vector search | OpenSearch Serverless | nanoclaw-documents |
| Message queue | ElastiCache Redis | nanoclaw-redis-ec2vpc |
| Secrets | Secrets Manager | nanoclaw/app-config |
| LLM | Bedrock | global.anthropic.claude-opus-4-7 |
| Container images | ECR | nanoclaw/orchestrator, nanoclaw/agent |

## Failure Scenarios

### Scenario 1: EC2 Instance Failure
1. `aws ec2 describe-instances --instance-ids i-0f9cd20350cfdc1a6` — confirm state
2. If terminated/stopped and EBS detached: launch new r6i.4xlarge in ap-southeast-1a, same IAM role, same SG
3. User-data bootstrap: pull latest ECR image + start container
4. Update EIP association if applicable
5. Verify: `curl http://<new-ip>:3000/health`
6. Update DNS/IP in any external config

**Expected recovery time: 15–20 min**

### Scenario 2: Container Crash (orchestrator)
```bash
# Check status
aws ssm send-command --instance-ids i-0f9cd20350cfdc1a6 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["docker ps -a | grep nanoclaw && docker logs nanoclaw-orchestrator --tail 50"]'

# Restart
aws ssm send-command --instance-ids i-0f9cd20350cfdc1a6 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["docker restart nanoclaw-orchestrator"]'

# If image corrupt — pull fresh
aws ssm send-command --instance-ids i-0f9cd20350cfdc1a6 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["aws ecr get-login-password --region ap-southeast-1 | docker login --username AWS --password-stdin 709609992277.dkr.ecr.ap-southeast-1.amazonaws.com && docker pull 709609992277.dkr.ecr.ap-southeast-1.amazonaws.com/nanoclaw/orchestrator:latest && docker tag ... nanoclaw-orchestrator:current && docker restart nanoclaw-orchestrator"]'
```
**Expected recovery time: 2–5 min**

### Scenario 3: DynamoDB Data Loss
```bash
# List available PITR restore points
aws dynamodb describe-continuous-backups --table-name nanoclaw-chat-messages

# Restore to a new table
aws dynamodb restore-table-to-point-in-time \
  --source-table-name nanoclaw-chat-messages \
  --target-table-name nanoclaw-chat-messages-restored \
  --restore-date-time 2026-01-01T12:00:00Z

# Swap table name in Secrets Manager after verifying restored table
aws secretsmanager update-secret --secret-id nanoclaw/app-config \
  --secret-string '{"chat_messages_table":"nanoclaw-chat-messages-restored",...}'
```
**Expected recovery time: 20–30 min**

### Scenario 4: Redis Failure
- Redis (ElastiCache) is **stateless cache** — in-flight messages lost but no data corruption
- Failover is automatic (Multi-AZ enabled on production cluster)
- If manual restart needed: AWS Console → ElastiCache → nanoclaw-redis-ec2vpc → Reboot
- WhatsApp sessions stored in S3 (session backup module) — re-scan QR only if session backup is stale

**Expected recovery time: 5 min (automatic), 10 min (manual)**

### Scenario 5: WhatsApp Session Expired
1. Visit admin dashboard: http://3.0.132.150:3000/admin (admin / NcLaw$2026!xK9m)
2. Navigate to WhatsApp tab → scan QR code with phone
3. Session active within 30s
4. S3 session backup will sync new credentials within 5 min

**Expected recovery time: 2 min**

### Scenario 6: Secrets Manager Unavailable
- All secrets cached in process memory at startup
- Running container continues normally
- New container restarts will fail until SM recovers
- Monitor: AWS Health Dashboard for SM regional events
- Mitigation: pre-warm secrets on container start with retry logic

### Scenario 7: ECR Unavailable
- Running containers unaffected (image already pulled)
- New deployments via CD pipeline will fail at build/push step
- Rollback: containers continue running on existing image

## Backup Verification Schedule

| Schedule | Task |
|----------|------|
| Weekly | Verify DynamoDB PITR enabled for all 4 tables |
| Weekly | Verify S3 versioning on nanoclaw-data-709609992277 |
| Monthly | Test restore from DynamoDB PITR to staging table |
| Monthly | Test EC2 instance replacement (non-production) |
| Quarterly | Full DR exercise: simulate EC2 failure, restore, measure RTO |

## Runbook Verification Log
| Date | Scenario | RTO Achieved | Operator | Notes |
|------|----------|-------------|---------|-------|
| — | — | — | — | Not yet tested |

## Contacts
- Admin dashboard: http://3.0.132.150:3000/admin
- AWS Console: account 709609992277, region ap-southeast-1
- GitHub Actions: https://github.com/tokenlab42/pocketclaw/actions
- EC2 instance: i-0f9cd20350cfdc1a6 (r6i.4xlarge, ap-southeast-1)
