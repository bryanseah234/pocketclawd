# Clawd / NanoClaw — Developer Setup

How to set up a development environment for Clawd. The deployed system runs
entirely on AWS (`ap-southeast-1`) — there is no local-only deployment mode
for the cloud surface. Local development means: build, typecheck, test, and
optionally point a local orchestrator at the live AWS dev resources.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | **22 LTS** | `nvm install 22` (Node 26 will fail `better-sqlite3` builds) |
| pnpm | 10+ | `npm install -g pnpm` |
| Python | 3.11 (sub-agent) | uv-managed venv preferred |
| uv | latest | `pip install uv` or `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Docker | latest | required for image builds and local Postgres if you want legacy local mode |
| AWS CLI | v2 | `aws.amazon.com/cli` |
| Terraform | ≥ 1.5 | only required for infra changes |
| ripgrep | latest | `winget install BurntSushi.ripgrep.MSVC` (search tooling) |

### AWS access

You need credentials for account `709609992277`. Use SSO if available:

```bash
aws configure sso             # set region ap-southeast-1
aws sts get-caller-identity   # sanity check
```

The default IAM identity used during this build is
`arn:aws:iam::709609992277:user/bryan.seah.hongi`.

---

## Clone and install

```bash
git clone https://github.com/tokenlab42/pocketclaw.git
cd pocketclaw
pnpm install
pnpm run build
```

> **Windows + exFAT note.** This repo lives at `X:\01 REPOSITORIES\pocketclaw`
> on an exFAT drive. The `.npmrc` sets `node-linker=hoisted` so pnpm avoids
> symlinks. If `pnpm install` keeps crashing on the `sharp` postinstall, run
> `pnpm install --lockfile-only` instead — CI rebuilds it cleanly on Linux.

---

## Environment variables

Copy the sample and fill in the local-dev values:

```bash
cp .env.sample .env
```

Required:

```env
# Cloud mode — activates AWS clients in src/cloud/bootstrap.ts
NANOCLAW_ENV=cloud
AWS_REGION=ap-southeast-1

# Pinned to the prod bucket because dev shares the same data plane
DATA_BUCKET=nanoclaw-data-709609992277

# Admin auth (rotate via Secrets Manager in prod)
ADMIN_USER=admin
ADMIN_PASS=change-me-locally
```

Everything else (Redis endpoint, DynamoDB tables, OpenSearch URL, Bedrock model
IDs, ECR registry) is read at runtime from `nanoclaw/app-config` in Secrets
Manager — you don't put those in `.env`.

---

## Run locally

### Orchestrator (Node)
```bash
pnpm run start                      # talks to live AWS dev resources
```

### Sub-agent (Python) — local
```bash
cd container/sub-agent
uv sync
uv run python -m src.main           # connects to the same Redis / DynamoDB
```

### Both via docker compose (legacy local mode)
```bash
docker compose up --build orchestrator sub-agent
```

---

## Tests

| Suite | How to run |
|---|---|
| TypeScript typecheck | `pnpm run typecheck` |
| Vitest — cloud | `pnpm exec vitest run src/cloud --reporter=basic` |
| Vitest — admin dashboard | `pnpm exec vitest run -c vitest.admin-dashboard.config.ts` |
| Vitest — full | `pnpm exec vitest run` |
| Pytest — sub-agent | `cd container/sub-agent && uv run pytest` |
| Lint | `pnpm run lint` |
| Terraform | `cd infrastructure/terraform && terraform fmt && terraform validate && terraform test` |

Current baseline (commit `9abee18`):
- TypeScript: 0 errors
- Vitest cloud: 460/460 pass
- Vitest admin: 84/84 pass
- Pytest sub-agent: 286 pass / 1 xfail

Running tests on Windows? Invoke `vitest` directly via `node` to bypass cygwin
fork crashes:
```bash
node node_modules/vitest/vitest.mjs run src/cloud --reporter=basic
```

---

## AWS infrastructure

Infrastructure is managed via Terraform in `infrastructure/terraform/`.
This repo's HEAD already represents the deployed state — only run `apply`
when you intend to change it.

```bash
cd infrastructure/terraform
terraform init
terraform plan
terraform apply
```

### Live resources (snapshot — see docs/aws-resource-inventory.md for the full list)

| Resource | Identifier |
|---|---|
| EC2 instance | `i-0f9cd20350cfdc1a6` (t3.xlarge, ap-southeast-1a) |
| EBS root | `vol-0c15cf0eccb7dd78e` (128 GB gp3) |
| Public IP | `3.0.132.150` (port 22 + 3000 open; lock down post-incident) |
| ECS cluster | `nanoclaw-cluster` |
| ECS service | `nanoclaw-sub-agent` (Fargate, 1 task, 1024/2048) |
| Redis | `nanoclaw-redis-ec2vpc` (`nanoclaw-redis-ec2vpc.sipa0z.0001.apse1.cache.amazonaws.com:6379`) |
| OpenSearch | `nanoclaw-documents` (`66ik2p21jw225em9uj25.ap-southeast-1.aoss.amazonaws.com`) |
| S3 | `nanoclaw-data-709609992277` |
| DynamoDB | `nanoclaw-chat-messages`, `nanoclaw-user-preferences`, `nanoclaw-webhook-tokens`, `nanoclaw-system-errors` |
| ECR | `nanoclaw/orchestrator`, `nanoclaw/agent` |
| Secrets | `nanoclaw/app-config`, `nanoclaw/google-secrets` |

---

## Common dev workflows

### Add a feature → ship it
```bash
git checkout -b feature/<thing> feature/nanoclaw-aws-deployment
# edit, test
git add -A
git commit --no-verify -m "feat(scope): description"
git push --no-verify origin feature/<thing>
# open PR against feature/nanoclaw-aws-deployment
```

The pre-push and commit-msg hooks are sh scripts that crash on Windows cygwin;
`--no-verify` is required on both `commit` and `push` from this host.

### Hot-swap the persona
```bash
aws secretsmanager get-secret-value --secret-id nanoclaw/app-config \
  --region ap-southeast-1 --query SecretString --output text > /tmp/cfg.json
# edit the systemPromptTemplate field
aws secretsmanager put-secret-value --secret-id nanoclaw/app-config \
  --region ap-southeast-1 --secret-string file:///tmp/cfg.json
# orchestrator picks it up within 5 min (cache TTL); restart for instant pickup
```

### Tail the sub-agent
```bash
aws logs tail /ecs/nanoclaw-sub-agent --follow --region ap-southeast-1
```

### SSH onto the EC2 (recovery)
```bash
aws ec2-instance-connect send-ssh-public-key \
  --instance-id i-0f9cd20350cfdc1a6 --instance-os-user ubuntu \
  --availability-zone ap-southeast-1a \
  --ssh-public-key file://"$HOME/eic-key.pub"
ssh -i "$HOME/eic-key" ubuntu@3.0.132.150
```

The Instance Connect key TTL is 60 s — re-push before each ssh batch.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Bedrock `ValidationException ... on-demand throughput` | Use the inference-profile id (`global.anthropic.claude-sonnet-4-5-...`), not the bare model id |
| AOSS opaque 403 | IAM is missing `aoss:APIAccessAll`; data-access policy alone is not enough |
| `Cloud response missing routing fields` | Sub-agent forgot to echo `channelType / platformId / threadId / kind` into response metadata |
| `not valid JSON` in response poll | Content was passed raw; wrap as `JSON.stringify({text: rawContent})` |
| `failed to push some refs` (no detail) | Pass `--no-verify` on both commit and push |
| `dofork: child died` (Windows) | Cygwin DLL rebase issue; invoke node/python directly via subprocess |
| Sharp postinstall fails | Use `pnpm install --lockfile-only`; CI rebuilds cleanly on Linux |
