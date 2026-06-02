# Deployment

Clawd runs cloud-only on AWS ap-southeast-1 (account 709609992277).
Use --profile clawd-prod for all AWS CLI commands.

## Architecture summary

- EC2 i-0f9cd20350cfdc1a6: orchestrator (Node.js, systemd service nanoclaw)
- ECS Fargate: sub-agent pool (cluster nanoclaw-cluster, service nanoclaw-sub-agent, 2 tasks)
- ECR: nanoclaw/orchestrator and nanoclaw/agent (latest + commit SHA tags)
- Secrets Manager nanoclaw/app-config: all runtime config

## CI/CD (normal deploy path)

Push to feature/nanoclaw-aws-deployment triggers two GitHub Actions workflows:

1. CI: lint, vitest, pytest, k6 load test (threshold: error_rate < 1%)
2. Deploy Feature Branch: docker build, ECR push, ECS force-redeploy

The ECS service does a rolling update (2 tasks). New tasks pull the latest
image tag. Old tasks drain then stop. Full rollout takes 3-5 minutes.

## Manual sub-agent deploy

```bash
# Build and push image
aws ecr get-login-password --region ap-southeast-1 --profile clawd-prod   | docker login --username AWS --password-stdin     709609992277.dkr.ecr.ap-southeast-1.amazonaws.com

docker build -t nanoclaw/agent:latest container/sub-agent/
docker tag nanoclaw/agent:latest   709609992277.dkr.ecr.ap-southeast-1.amazonaws.com/nanoclaw/agent:latest
docker push 709609992277.dkr.ecr.ap-southeast-1.amazonaws.com/nanoclaw/agent:latest

# Force ECS redeploy
aws ecs update-service   --cluster nanoclaw-cluster   --service nanoclaw-sub-agent   --force-new-deployment   --profile clawd-prod --region ap-southeast-1
```

## Manual orchestrator deploy

```bash
# SSH via SSM
aws ssm start-session --target i-0f9cd20350cfdc1a6   --profile clawd-prod --region ap-southeast-1

# On EC2
cd /opt/nanoclaw
git pull
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart nanoclaw
sudo systemctl status nanoclaw
```

## Secrets Manager

All runtime config lives in nanoclaw/app-config.
Never overwrite wholesale. Always read -> merge -> write:

```bash
# Read current
aws secretsmanager get-secret-value   --secret-id nanoclaw/app-config   --profile clawd-prod --region ap-southeast-1   --query SecretString --output text | python3 -m json.tool

# Merge a single key (example)
# Read -> parse -> set key -> write back
```

Keys in nanoclaw/app-config:
- LLM_MODEL_ID: bedrock model ID for the sub-agent
- EMBEDDING_MODEL_ID: Titan Embed v2 model ID
- OPENSEARCH_ENDPOINT: AOSS collection endpoint
- REDIS_URL: ElastiCache connection string
- DYNAMODB_CHAT_TABLE, DYNAMODB_PREFS_TABLE: table names
- DATA_BUCKET: S3 bucket name
- TELEGRAM_BOT_TOKEN: bot API token
- WHATSAPP_AUTH_DIR: Baileys session path (default ~/.clawd/whatsapp/)
- ADMIN_PASS: admin dashboard basic auth password (do not rotate)
- BEDROCK_REGION: ap-southeast-1

## OneCLI agent secret mode

When the orchestrator first spawns a session for a new agent group,
OneCLI creates the agent in selective secret mode (no secrets assigned).
If a container gets 401 errors from AWS APIs despite valid vault credentials:

```bash
onecli agents list                          # find agent id
onecli agents set-secret-mode --id <id> --mode all
```

## Environment variables (EC2 orchestrator)

Set in /etc/nanoclaw/orchestrator.env:

```
NANOCLAW_ENV=cloud
AWS_REGION=ap-southeast-1
DATA_BUCKET=nanoclaw-data-709609992277
REDIS_URL=redis://nanoclaw-redis.sipa0z.0001.apse1.cache.amazonaws.com:6379
CLAWD_CRON_DIGEST=true
SKIP_CONTAINER_RUNTIME_CHECK=1
```

## Environment variables (ECS sub-agent task definition)

Injected from Secrets Manager at container start:
OPENSEARCH_ENDPOINT, REDIS_URL, DATA_BUCKET, LLM_MODEL_ID, EMBEDDING_MODEL_ID,
DYNAMODB_CHAT_TABLE, DYNAMODB_PREFS_TABLE, AWS_REGION.

## Checking deploy status

```bash
# ECS service health
aws ecs describe-services   --cluster nanoclaw-cluster --services nanoclaw-sub-agent   --profile clawd-prod --region ap-southeast-1   --query 'services[0].{running:runningCount,pending:pendingCount,desired:desiredCount,taskDef:taskDefinition}'

# Latest sub-agent logs
aws logs tail /ecs/nanoclaw-sub-agent --since 30m   --profile clawd-prod --region ap-southeast-1

# Orchestrator logs on EC2
sudo journalctl -u nanoclaw -n 100 --no-pager
```

## Pending work

- C9: Caddy + Let's Encrypt TLS on EC2. After that, swap Telegram from
  long-poll to webhook. See docs/runbooks/caddy-tls.md.
- C10: Security group lockdown (restrict inbound to SG/known IPs after C9).
- Microsoft ingestion: add MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET
  to /etc/nanoclaw/orchestrator.env on EC2.
