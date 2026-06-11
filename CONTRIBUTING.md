# Contributing

## Commit format

```
<type>(<scope>): <description>
```

Types: feat, fix, chore, docs, test, refactor, perf
Max 72 chars. Examples:

```
feat(tools): add generate_document tool (PDF + DOCX)
fix(reminders): fire to correct channel (WA vs Telegram)
chore(deps): bump boto3 to 1.35.71
```

## Branch naming

```
feature/<slug>
fix/<slug>
bugfix/<slug>
hotfix/<slug>
chore/<slug>
```

## Branch layout

- main -- stable, mirrors upstream NanoClaw
- feature/nanoclaw-aws-deployment -- active Clawd deployment branch
- channels -- channel adapters (Telegram, WhatsApp, Discord, etc.)
- providers -- non-default agent providers

Channel and provider code lives on sibling branches and is copied in by
.claude/skills/add-<name>/SKILL.md scripts. Never commit channel code to main.

## Dependencies

- Node: use pnpm. Lock file must be committed.
- Python: use uv. pyproject.toml + uv.lock must be committed.
- Node 22 required (.nvmrc). better-sqlite3 does not compile against Node 26.
- ExFAT drive (X:) requires node-linker=hoisted in .npmrc (no symlinks).

## Pre-commit hooks

```bash
bash scripts/setup_hooks.sh     # Linux / macOS / WSL
powershell scripts/setup_hooks.ps1   # Windows
```

## Tests

```bash
pnpm test                        # orchestrator (vitest)
cd container/sub-agent && uv run pytest   # sub-agent
```

CI runs both on every push. The k6 load test runs during deploy and allows
up to 1% error rate (rolling restart causes transient spikes).

## Secrets and credentials

Never commit secrets. All runtime credentials live in AWS Secrets Manager
at nanoclaw/app-config. The OneCLI gateway injects them into containers at
request time. See docs/05-security.md.

## Deploying

Push to feature/nanoclaw-aws-deployment triggers CI then the Deploy Feature
Branch workflow, which builds the sub-agent image, pushes to ECR, and
force-redeploys the ECS service. The orchestrator on EC2 picks up the new
image on next task restart. See docs/03-deployment.md.

## Live-prod safety

Before any change to live AWS resources:
- Plan first, execute second. Never force-push to main.
- Use --profile clawd-prod for all AWS CLI commands.
- Read then merge when writing to Secrets Manager (never overwrite wholesale).
- Gate risky wiring behind env flags defaulting to false.
