# Clawd / NanoClaw — CI/CD Pipeline

## What is CI? What is CD?

**CI (Continuous Integration)** answers: *is this code correct?*
Every push triggers automated checks — typecheck, vitest, pytest, terraform validate.
Catches regressions before they reach production.

**CD (Continuous Deployment)** answers: *is this code live?*
If CI passes, automatically build Docker images, push to ECR, deploy to EC2 + ECS.

CI gates CD — deploy never runs unless CI passes.

---

## Pipeline (feature branch)

```
Push to feature/nanoclaw-aws-deployment
                │
                ▼
   ┌─────────────────────────────────────────────────────────┐
   │ Quality gates (parallel)                                │
   │   • pnpm run typecheck       (TypeScript, 0 errors)    │
   │   • pnpm exec vitest run     (≥ 460 cloud, 84 admin)   │
   │   • pytest (sub-agent)       (≥ 286 tests)             │
   │   • terraform fmt + validate + test                     │
   │   • tfsec (security scan)                               │
   └─────────────────────┬───────────────────────────────────┘
                         │ (all green)
                         ▼
   ┌─────────────────────────────────────────────────────────┐
   │ Build & Push to ECR                                     │
   │   • docker build orchestrator (Node 22 alpine)          │
   │   • docker build agent        (Python 3.11 slim)        │
   │   • push :<sha> + :feature-latest to                    │
   │     709609992277.dkr.ecr.ap-southeast-1.amazonaws.com   │
   └─────────────────────┬───────────────────────────────────┘
                         │
                         ▼
   ┌─────────────────────────────────────────────────────────┐
   │ Deploy                                                  │
   │   • SSM → EC2: BLUE/GREEN — pre-pull image as :next,    │
   │     smoke-test on :3001 (bridge net), swap to :current, │
   │     restart orchestrator (full env per AWS-DEPLOYMENT)  │
   │   • aws ecs update-service nanoclaw-sub-agent           │
   │     --force-new-deployment   ← rolls Fargate task       │
   │   • Health check /health   (15 retries × 5s)            │
   └─────────────────────┬───────────────────────────────────┘
                         │
                         ▼
   ┌─────────────────────────────────────────────────────────┐
   │ External health probe                                   │
   │   curl http://3.0.132.150:3000/health  (8 × 15s)        │
   └─────────────────────────────────────────────────────────┘
```

If the health probe fails, the deploy is marked failed. Production rail
(`deploy.yml`) additionally auto-rollbacks to the prior tag stored in SSM
Parameter Store.

---

## Workflows

| File | Trigger | CI | CD |
|---|---|---|---|
| `.github/workflows/ci.yml` | every push | ✅ | ❌ |
| `.github/workflows/deploy-feature.yml` | push to `feature/nanoclaw-aws-deployment` | ✅ | ✅ feature EC2 + ECS |
| `.github/workflows/deploy.yml` | push to `main` / `staging` | ✅ | ✅ production rail with auto-rollback |

The active iterating branch is `feature/nanoclaw-aws-deployment`. Production
rail (`deploy.yml`) currently shares the same EC2 instance — if you bring up
a separate prod instance, set `PRODUCTION_INSTANCE_ID` accordingly.

---

## GitHub secrets

| Secret | Purpose |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | OIDC role assumed by GHA — `arn:aws:iam::709609992277:role/nanoclaw-github-deploy` |
| `ECR_REGISTRY` | `709609992277.dkr.ecr.ap-southeast-1.amazonaws.com` |
| `EC2_INSTANCE_ID` | `i-0f9cd20350cfdc1a6` (feature + production share this for now) |
| `HEALTH_URL` | `http://3.0.132.150:3000/health` |
| `ADMIN_PASS` | Basic auth password injected at container start |

OIDC trust policy on the role is bound to:
```
"sub": "repo:tokenlab42/pocketclaw:ref:refs/heads/*"
"aud": "sts.amazonaws.com"
```

No long-lived AWS keys ever touch GitHub.

---

## Quality-gate baselines (commit `9abee18`)

| Gate | Status |
|---|---|
| TypeScript | 0 errors |
| Vitest — `src/cloud` | 460 / 460 ✅ |
| Vitest — admin dashboard | 84 / 84 ✅ |
| Pytest — sub-agent | 286 pass + 1 xfail ✅ |
| Terraform validate | clean |
| Terraform test | clean |
| tfsec | findings register tracked in `docs/security-assessment.md` |

If a gate goes red, fix it on the feature branch before pushing — don't
disable the gate.

---

## Local pre-flight

Run these before pushing to avoid red CI:

```bash
pnpm run typecheck
pnpm exec vitest run --reporter=basic
pnpm exec vitest run -c vitest.admin-dashboard.config.ts
cd container/sub-agent && uv run pytest
cd ../../infrastructure/terraform && terraform fmt && terraform validate
```

On Windows hosts, invoke vitest directly via node:
```bash
node node_modules/vitest/vitest.mjs run --reporter=basic
```
…to bypass cygwin fork crashes.

---

## Action versions backlog

GitHub-blog-posted timeline forces Node 20 actions off the runner by
**June 2nd 2026**, with full removal on **September 16th 2026**. The
following actions in our workflows still pin to Node-20 majors and should
bump before then:

- `actions/checkout@v4` → v5
- `aws-actions/configure-aws-credentials@v4` → v5
- `docker/build-push-action@v6` → latest
- `docker/setup-buildx-action@v3` → latest
