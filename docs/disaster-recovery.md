# Clawd / NanoClaw — Disaster Recovery Runbook

## RTO / RPO targets

| Target | Value |
|---|---|
| RTO (Recovery Time Objective) | 30 minutes |
| RPO (Recovery Point Objective) | 5 minutes — DynamoDB PITR + S3 versioning. Redis is best-effort (in-flight messages may be lost during a failover). |

---

## Component map

| Component | AWS service | Identifier |
|---|---|---|
| Orchestrator | EC2 r6i.4xlarge | `i-0f9cd20350cfdc1a6` |
| Sub-agent | ECS Fargate | `nanoclaw-cluster/nanoclaw-sub-agent` |
| Chat storage | DynamoDB | `nanoclaw-chat-messages` |
| User preferences | DynamoDB | `nanoclaw-user-preferences` |
| Webhook tokens | DynamoDB | `nanoclaw-webhook-tokens` |
| System errors | DynamoDB | `nanoclaw-system-errors` |
| Object storage | S3 | `nanoclaw-data-709609992277` |
| Vector search | OpenSearch Serverless | `nanoclaw-documents` (`66ik2p21jw225em9uj25`) |
| Message queue | ElastiCache Redis | `nanoclaw-redis-rg.sipa0z.0001.apse1.cache.amazonaws.com:6379` |
| Secrets | Secrets Manager | `nanoclaw/app-config`, `nanoclaw/google-secrets` |
| LLM | Bedrock | `global.anthropic.claude-sonnet-4-5-...` (orchestrator + sub-agent), `cohere.embed-multilingual-v3` (embedding, 1024-dim) |
| Container registry | ECR | `nanoclaw/orchestrator`, `nanoclaw/agent` |

---

## Failure scenarios

### 1. Orchestrator container crash

Symptoms: `/health` endpoint returns 500 or refuses connections; admin
dashboard unreachable; WhatsApp messages not being acknowledged.

```bash
# Check status (via SSM if reachable, else EC2 Instance Connect)
aws ssm send-command --instance-ids i-0f9cd20350cfdc1a6 \
  --document-name AWS-RunShellScript --region ap-southeast-1 \
  --parameters 'commands=["docker ps -a | grep nanoclaw && docker logs nanoclaw-orchestrator --tail 50"]'

# Restart
aws ssm send-command --instance-ids i-0f9cd20350cfdc1a6 \
  --document-name AWS-RunShellScript --region ap-southeast-1 \
  --parameters 'commands=["docker restart nanoclaw-orchestrator"]'

# If image corrupt — pull fresh from ECR and redeploy
aws ssm send-command --instance-ids i-0f9cd20350cfdc1a6 \
  --document-name AWS-RunShellScript --region ap-southeast-1 \
  --parameters 'commands=[
    "aws ecr get-login-password --region ap-southeast-1 | docker login --username AWS --password-stdin 709609992277.dkr.ecr.ap-southeast-1.amazonaws.com",
    "docker pull 709609992277.dkr.ecr.ap-southeast-1.amazonaws.com/nanoclaw-orchestrator:current",
    "docker stop nanoclaw-orchestrator && docker rm nanoclaw-orchestrator",
    "docker run -d --name nanoclaw-orchestrator --restart unless-stopped --user root --network host -v /var/run/docker.sock:/var/run/docker.sock -v /opt/nanoclaw-data:/app/data -e NANOCLAW_ENV=cloud -e AWS_REGION=ap-southeast-1 -e USE_SUBAGENT=1 -e WHATSAPP_ENABLED=true -e DATA_BUCKET=nanoclaw-data-709609992277 -e CLAWD_CRON_DIGEST=true -e CLAWD_CRON_DIGEST=true -e CLAWD_GOOGLE_SECRET_ID=nanoclaw/google-secrets 709609992277.dkr.ecr.ap-southeast-1.amazonaws.com/nanoclaw-orchestrator:current"
  ]'
```

**Expected recovery: 2–3 min.**

### 2. Sub-agent task unhealthy

Symptoms: WhatsApp messages get queued but no replies; sub-agent ECS health
check fails.

```bash
# Force a fresh deployment
aws ecs update-service --cluster nanoclaw-cluster --service nanoclaw-sub-agent \
  --force-new-deployment --region ap-southeast-1

# Watch the rollout
aws ecs describe-services --cluster nanoclaw-cluster --services nanoclaw-sub-agent \
  --region ap-southeast-1 \
  --query 'services[0].{state:deployments[0].rolloutState,running:runningCount,events:events[0:3]}'

# Tail logs
aws logs tail /ecs/nanoclaw-sub-agent --follow --region ap-southeast-1
```

**Expected recovery: 3–5 min** (Fargate task launch + image pull + Redis connect).

### 3. EC2 instance failure

Symptoms: instance state `stopped` or `terminated`; SSM unreachable; public
IP unresponsive.

```bash
aws ec2 describe-instances --instance-ids i-0f9cd20350cfdc1a6 --region ap-southeast-1

# If terminated and EBS detached, launch a new one with same SG and IAM role
# via terraform:
cd infrastructure/terraform
# ensure terraform.tfvars has the desired instance_type
terraform plan
terraform apply -target=aws_instance.nanoclaw

# Bootstrap pulls latest ECR image and starts the container via user-data.
# Verify:
curl http://<new-public-ip>:3000/health
```

If a new IP was assigned, update DNS / any external webhook URLs.

**Expected recovery: 15–20 min.**

### 4. EC2 disk full

Symptoms (the canonical sequence): `aws ssm send-command` returns
`Status=Failed`, `ResponseCode=1`, `ExecutionElapsedTime=PT0S`, empty output.
Console output shows `No space left on device` plus `lookup ... connection
refused`. The chain: disk full → systemd-resolved can't write cache →
DNS dies → SSM agent hibernates.

Recovery:
```bash
# 1. Expand the EBS volume
aws ec2 modify-volume --volume-id vol-0c15cf0eccb7dd78e --size 256 --region ap-southeast-1

# 2. Open an interactive shell via SSM Session Manager
#    (SSH/port 22 is CLOSED — admin_ssh_cidrs=[]; SSM is the only host access path)
aws ssm start-session --target i-0f9cd20350cfdc1a6 --region ap-southeast-1

# 3. Grow partition + filesystem
sudo growpart /dev/nvme0n1 1
sudo resize2fs /dev/nvme0n1p1
df -h /

# 4. Reclaim space
sudo docker system prune -af
# (NOT --volumes if you have bind-mounted /opt/nanoclaw-data — check first)

# 5. Re-deploy fresh image via SSM RunShellScript (don't wait for GHA rebuild)
ECR=709609992277.dkr.ecr.ap-southeast-1.amazonaws.com
aws ecr get-login-password --region ap-southeast-1 | sudo docker login --username AWS --password-stdin $ECR
sudo docker pull $ECR/nanoclaw-orchestrator:current
sudo docker stop nanoclaw-orchestrator && sudo docker rm nanoclaw-orchestrator
sudo docker run -d ...   # full env block per docs/AWS-DEPLOYMENT.md §5
```

This sequence is documented as a Hermes skill at
`~/.hermes/skills/devops/aws-ec2-disk-full-recovery/SKILL.md`.

**Expected recovery: 10–15 min.**

### 5. WhatsApp session lost

Symptoms: orchestrator log shows `Connection closed` or `Stream Errored`;
WhatsApp messages go un-acknowledged; admin dashboard QR section shows
"disconnected".

```bash
# Re-pair via admin dashboard
open http://3.0.132.150:3000/admin
# Tab "WhatsApp" → click "Generate new QR" → scan with phone

# If dashboard is down, force fresh QR via SSM Session Manager
aws ssm start-session --target i-0f9cd20350cfdc1a6 --region ap-southeast-1
# then, inside the session:
sudo docker exec nanoclaw-orchestrator rm -rf /app/sessions/baileys_auth_info
sudo docker restart nanoclaw-orchestrator
sudo docker logs -f nanoclaw-orchestrator   # scan QR from log output
```

**Expected recovery: 1–2 min.**

### 6. Bedrock throttling / region outage

Symptoms: `ThrottlingException` or `ServiceUnavailableException` from
Bedrock; sub-agent log floods with retries.

Mitigation:
- Bedrock has built-in retries; the sub-agent's `BedrockClient` adds
  exponential backoff up to 30 s.
- For sustained throttling, request a quota increase on the Bedrock model
  (AWS console → Bedrock → Quotas).
- For a region outage, manual failover requires changing
  `nanoclaw/app-config:llm_region` and the embedding pipeline picks up the
  new region. Note that PDPA residency forbids serving SG users from
  regions outside SG, so this is **only** acceptable as a temporary
  emergency measure during a multi-region AWS outage.

### 7. OpenSearch 403 (after IAM change)

Symptoms: every RAG query fails with `RequestError(403)`; embedding indexing
silently fails; log shows opaque 403 with no policy match details.

Cause: someone removed `aoss:APIAccessAll` from the EC2 or task role.

```bash
aws iam put-role-policy --role-name nanoclaw-ec2-role \
  --policy-name aoss-api-access \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Action":"aoss:APIAccessAll",
      "Resource":"arn:aws:aoss:ap-southeast-1:709609992277:collection/66ik2p21jw225em9uj25"
    }]
  }'

# Same for sub-agent task role
aws iam put-role-policy --role-name nanoclaw-sub-agent-task-role \
  --policy-name aoss-api-access \
  --policy-document '...'
```

Plus verify the data-access policy still includes both principals.

**Expected recovery: 1 min after IAM propagation.**

### 8. Catastrophic — region-wide AWS outage

If `ap-southeast-1` itself goes down:
- All compute and managed services are unavailable.
- DynamoDB PITR can be restored to a different region in 1–4 h, but PDPA
  residency forbids serving traffic from outside SG.
- Recommended: declare maintenance, post status on the landing page footer
  via static HTML edit + S3 redirect, wait for region to recover.
- An Azure variant exists (see `nanoclaw-prd.html`) as a parallel reference
  but is not deployed and not failover-ready.

---

## Backup procedures

| Asset | Backup mechanism | Recovery |
|---|---|---|
| DynamoDB tables | PITR (point-in-time recovery) — 35 days | `aws dynamodb restore-table-from-backup` |
| S3 bucket | Versioning enabled | Restore previous version |
| OpenSearch collection | No native backup; serverless is single-AZ | Re-ingest from S3 documents |
| Redis | No backup (ephemeral; messages re-deliver from queue logic) | N/A |
| Secrets | Manual export to local KMS-encrypted backup | Manual reload |
| Container images | ECR image immutable + tagged per SHA + lifecycle keeps last 10 | Pull from ECR |
| WhatsApp session | Persisted to S3 `sessions/` prefix | S3 versioning + re-pair fallback |
| Code | GitHub `tokenlab42/pocketclaw` | `git clone` |

---

## Verification checklist (post-recovery)

```bash
# 1. Orchestrator health
curl http://3.0.132.150:3000/health

# 2. Admin dashboard reachable + Basic auth works
curl -u admin:<PASS> -i http://3.0.132.150:3000/admin

# 3. Sub-agent task running
aws ecs describe-services --cluster nanoclaw-cluster --services nanoclaw-sub-agent \
  --region ap-southeast-1 --query 'services[0].runningCount'   # expect 1

# 4. WhatsApp connected
curl -u admin:<PASS> http://3.0.132.150:3000/admin/api/health \
  | jq '.services[] | select(.name=="whatsappSession")'

# 5. Send a real message and confirm reply round-trip
# (best-effort — send a benign question to the WA number and watch logs)
```
