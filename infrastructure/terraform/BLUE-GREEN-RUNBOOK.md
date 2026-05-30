# Blue/Green Deploy Runbook (t6-40)

Zero-downtime deploy for the NanoClaw orchestrator, accounting for the
WhatsApp single-session constraint.

## The hard constraint

The orchestrator holds a **stateful WhatsApp (Baileys) websocket**. WhatsApp
permits exactly ONE active session per number. If a second orchestrator logs in
with the same credentials, WhatsApp forcibly logs out the first. Therefore:

- You CANNOT run blue and green orchestrators live in parallel on the WA path.
- True parallel blue/green only applies to the **HTTP surface** (/health, admin
  UI, webhooks), which the ALB load-balances and drains.
- The **WhatsApp session** requires a **sequenced handoff** with a brief
  (seconds) gap. This is inherent to a single-session protocol; no
  infrastructure removes it.

Because WA auth state is backed up to S3 (`src/whatsapp-session-backup.ts`) and
restored on start, the handoff is: blue does a final S3 backup on SIGTERM ->
green restores from S3 and re-claims the session.

## What is and isn't zero-downtime

| Surface            | Behavior on deploy                                  |
|--------------------|-----------------------------------------------------|
| HTTP / webhooks    | Zero-downtime (ALB drain + green pre-warmed)        |
| Sub-agent (ECS)    | Zero-downtime (Fargate rolling update)              |
| WhatsApp session   | ~5-15s handoff gap (single-session protocol limit)  |
| In-flight LLM jobs | Survive (queued in Redis; sub-agents are separate)  |

## One-time infra setup (user-gated apply)

1. Enable the ALB in Terraform:
   ```
   enable_alb            = true
   alb_certificate_arn   = "arn:aws:acm:ap-southeast-1:...:certificate/..."  # for HTTPS
   public_subnet_b_cidr  = "10.0.3.0/24"   # default; ensure free in the VPC
   ```
   ```
   terraform plan -out tf.plan && terraform apply tf.plan
   terraform output alb_dns_name
   ```
2. Point your domain / WhatsApp webhook at `alb_dns_name`.
3. On the EC2 host, ensure `/etc/nanoclaw/orchestrator.env` holds the runtime
   env (it must NOT hard-set WHATSAPP_ENABLED -- the deploy script controls it).
4. Note the target group ARN: `terraform output` / console.

## Deploy

CI builds + pushes the image, then invokes the script on the host via SSM:

```
ECR_REGISTRY=<acct>.dkr.ecr.ap-southeast-1.amazonaws.com \
AWS_REGION=ap-southeast-1 \
IMAGE_TAG=<sha8> \
TG_ARN=<orchestrator target group arn> \
INSTANCE_ID=<i-...> \
bash scripts/deploy/blue-green.sh
```

Sequence (see the script header for detail):
1. Pull image, start **green** on :3001 with `WHATSAPP_ENABLED=false` (HTTP only).
2. Wait for green `/health`.
3. Register green with the ALB, wait healthy, deregister blue (drains).
4. SIGTERM blue (final S3 auth backup), then start the promoted instance on
   :3000 with `WHATSAPP_ENABLED=true` (restores WA from S3, re-claims session).
5. Verify health, swap ALB registration back to :3000, tag image `:current`.

## Rollback

- **Before step 4** (WA handoff): abort leaves blue serving -> true
  zero-downtime rollback. The script does this automatically on green health
  failure.
- **After step 4**: re-run the script with the previous `IMAGE_TAG` (stored at
  SSM `/nanoclaw/production/previous-image-tag`). If the WA session got into a
  bad state, force a re-pair: `purgeSession` wipes auth + S3 backup, then the
  next start shows a fresh QR (`src/index.ts:146`). A human must scan it.

## Why not ECS for the orchestrator too?

The WA session's single-writer requirement and its local auth-dir + S3 backup
lifecycle make a single pinned host simpler and less failure-prone than ECS
task churn. The sub-agent pool (stateless workers) IS on ECS Fargate, where
rolling updates are already zero-downtime. Revisit only if the WA session is
externalized behind a dedicated single-instance "session holder" service.
