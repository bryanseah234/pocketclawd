# CI/CD

Two GitHub Actions workflows on feature/nanoclaw-aws-deployment.

## CI (.github/workflows/ci.yml)

Triggers on every push.

Steps:
1. pnpm install + pnpm build (orchestrator TypeScript)
2. uv sync + pytest (sub-agent Python)
3. vitest (orchestrator unit tests)
4. gitleaks secret scan (sometimes flakes on Docker Hub pull timeouts -- transient)
5. k6 load test against staging (threshold: error_rate < 1%)

All steps must pass before Deploy runs.

## Deploy Feature Branch (.github/workflows/deploy-feature.yml)

Triggers after CI succeeds on feature/nanoclaw-aws-deployment.

Steps:
1. docker build container/sub-agent/
2. ECR login + docker push (latest + commit SHA tags)
3. aws ecs update-service --force-new-deployment
4. Wait for ECS service stability (2 tasks running, 0 pending)

Orchestrator on EC2 is NOT automatically redeployed -- requires manual
git pull + systemctl restart nanoclaw on the EC2 instance when orchestrator
source changes (src/**/*.ts).

## Sub-agent vs orchestrator changes

| Change location | Auto-deploys? |
|---|---|
| container/sub-agent/** | Yes (ECS rolling update) |
| src/** (orchestrator) | No -- manual EC2 redeploy needed |
| infrastructure/terraform/** | No -- manual terraform apply |

## Checking a deploy

```bash
# CI run status
gh run list --repo tokenlab42/pocketclaw   --branch feature/nanoclaw-aws-deployment --limit 4

# ECS task health
aws ecs describe-services   --cluster nanoclaw-cluster --services nanoclaw-sub-agent   --profile clawd-prod --region ap-southeast-1   --query 'services[0].{running:runningCount,pending:pendingCount}'

# Sub-agent logs
aws logs tail /ecs/nanoclaw-sub-agent   --profile clawd-prod --region ap-southeast-1 --since 15m
```

## Rollback

```bash
# Find previous task definition revision
aws ecs list-task-definitions --family-prefix nanoclaw-sub-agent   --sort DESC --profile clawd-prod --region ap-southeast-1

# Roll back to previous revision
aws ecs update-service   --cluster nanoclaw-cluster   --service nanoclaw-sub-agent   --task-definition nanoclaw-sub-agent:<PREV_REVISION>   --profile clawd-prod --region ap-southeast-1
```
