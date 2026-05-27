# CI/CD Pipeline Overview

## What is CI? What is CD?

**CI (Continuous Integration)** answers: *is this code correct?*
Every push triggers automated checks — typecheck, tests, lint.
Catches regressions before they reach production.

**CD (Continuous Deployment)** answers: *is this code live?*
If CI passes, automatically build Docker images, push to ECR, and deploy to EC2.

CI gates CD — deploy never runs unless CI passes.
They are two separate jobs in the same workflow file.

## NanoClaw Pipeline

```
Push to feature/nanoclaw-aws-deployment
         |
         v
   +--------------------------------+
   |  CI: Typecheck + Test          |  <- job: check
   |  - pnpm run typecheck          |     Zero TypeScript errors
   |  - pnpm exec vitest run        |     All 500+ tests pass
   +---------------+----------------+
                   | (only if CI passes)
                   v
   +--------------------------------+
   |  Build & Push to ECR           |  <- job: build
   |  - Docker build orchestrator   |     Node 20 alpine->slim
   |  - Docker build agent          |     Python 3.11 slim
   |  - Push :SHA + :feature-latest |
   +---------------+----------------+
                   | (only if build passes)
                   v
   +--------------------------------+
   |  Deploy to EC2                 |  <- job: deploy
   |  - Upload deploy.sh to S3      |     Avoids SSM quoting issues
   |  - SSM RunShellScript          |     Pull image, stop old, start new
   |  - Health check /health        |     15 retries x 5s = 75s window
   +---------------+----------------+
                   v
   +--------------------------------+
   |  External health check         |
   |  curl 3.0.132.150:3000/health  |     8 retries x 15s
   +--------------------------------+
```

## Workflows

| File | Trigger | CI | CD |
|------|---------|----|----|
| deploy-feature.yml | push to feature/nanoclaw-aws-deployment | Yes | Yes (feature EC2) |
| ci.yml | push to any branch | Yes | No |
| deploy.yml | push to main / staging | Yes | Yes (production) |

## GitHub Secrets

| Secret | Purpose |
|--------|---------|
| AWS_DEPLOY_ROLE_ARN | OIDC role for AWS authentication |
| STAGING_INSTANCE_ID | EC2 instance to deploy to |
| ECR_REGISTRY | Docker image registry URL |

## Adding Tests
Tests at `src/**/*.test.ts` are auto-discovered by vitest. No CI config change needed.

## Rollback
To roll back to a previous image:
```bash
# Find the last good SHA tag in ECR
aws ecr list-images --repository-name nanoclaw/orchestrator --region ap-southeast-1

# Deploy it via SSM
PREV_TAG=<sha>
aws ssm send-command --instance-ids i-0f9cd20350cfdc1a6 \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"docker pull 709609992277.dkr.ecr.ap-southeast-1.amazonaws.com/nanoclaw/orchestrator:$PREV_TAG && docker tag ... nanoclaw-orchestrator:current && docker restart nanoclaw-orchestrator\"]"
```
