# Clawd / NanoClaw — Security Model

Clawd enforces security through three layered controls: **data-isolation invariants** at the gateway, **least-privilege IAM** in AWS, and **PDPA-compliant lifecycle** for user data. Per-user process isolation is intentionally **not** the primary control — see "Sub-agent runtime" below for the rationale.

---

## Data isolation (the primary control)

Every persistence operation goes through the **DataGateway**, which enforces `userId` on every read and write. Cross-user access is impossible **by construction**, not by convention:

| Layer | Enforcement |
|---|---|
| DynamoDB | `userId` is the partition key on every table — queries physically cannot cross partitions |
| OpenSearch | Mandatory `{ term: { userId } }` filter on every search; `bool.should` pattern adds the `CORPORATE` sentinel for opted-in shared corpus |
| S3 | Every key prefixed with `users/{userId}/` or `staging/{userId}/`; path-traversal (`../`) rejected at write time |
| Redis | Per-user rate-limit + presence keys (`rate:{userId}:1m`, `presence:{userId}`); shared work queue is read-only by user processes |

The DataGateway's `assertUserId()` helper rejects `CORPORATE` in `deleteAllUserData()` and `exportUserData()` so a user cannot wipe shared documents through their own DSAR flow.

---

## Sub-agent runtime — what's the threat model

The Clawd-on-AWS sub-agent runs as a **shared ECS Fargate task** (1 task, 1 vCPU / 2 GB) that processes all users from a single Redis queue. This is intentional:

| Threat | Mitigation |
|---|---|
| Cross-user data access from inside the sub-agent | DataGateway invariants — every read carries the userId from the queue payload, never derived from process state |
| Sub-agent crash impact | ECS service `desiredCount=1` auto-restarts; queued messages re-deliver on restart |
| Code injection from malicious uploads | MIME-type magic-byte validation, fixed allow-list of extensions, no executable formats |
| Prompt injection | Persona's `guardrails` tier explicitly tells the LLM to ignore role-override attempts; no user-supplied text reaches `system` role |

Per-user Docker isolation (the legacy NanoClaw v2 model) was traded for shared-task economics; data isolation moved from the **process** layer to the **data** layer. This is the same pattern OpenAI / Anthropic / Cohere use in their hosted endpoints.

---

## Secrets management

### AWS Secrets Manager
- `nanoclaw/app-config` — runtime configuration: Redis endpoint, DynamoDB table names, OpenSearch URL, S3 bucket, Bedrock model IDs, ECR registry, persona template.
- `nanoclaw/google-secrets` — Google OAuth client + access tokens for ingestion (placeholders today; populated by Bryan via console).

Both secrets are read at orchestrator boot and refreshed every 5 minutes
(in-memory TTL cache). No long-lived AWS credentials live anywhere — IAM roles
provide service-to-service auth via the EC2 instance profile and the ECS task
execution role.

### Rotation

| Secret | Rotation | Access |
|---|---|---|
| Admin dashboard password | Manual (90-day target) | Bryan |
| Redis auth (when enabled) | 90 days | Orchestrator + sub-agent |
| Google OAuth client secret | On user re-grant | Orchestrator only |
| DynamoDB / OpenSearch / S3 / Bedrock | IAM (no static keys) | per-component task / instance role |

The orchestrator does NOT pass secrets to the sub-agent as env vars or chat
context. The sub-agent has its own Bedrock and Redis client identities through
its ECS task role.

---

## Network controls

### EC2 security group `sg-04077e2294b216bbc`

| Direction | Port | Source | Purpose |
|---|---|---|---|
| Inbound | 80, 443 | 0.0.0.0/0 | Caddy + Let's Encrypt (when TLS enabled) |
| Inbound | 3000 | 0.0.0.0/0 | Orchestrator HTTP (admin + landing) |
| Inbound | 22 | 0.0.0.0/0 | EC2 Instance Connect (recovery only — lock down after each incident) |
| Outbound | 443 | * | AWS service endpoints, Baileys → WhatsApp |
| Outbound | 5222, 5223 | * | WhatsApp websocket |

**Hardening backlog:** lock 22/3000 to admin IP set, front 3000 with HTTPS via Caddy, drop direct :3000 once Caddy is up.

### VPC topology
- VPC `vpc-0eaf5fb467fe952b8` in `ap-southeast-1`
- EC2 in `ap-southeast-1a` private subnet w/ NAT gateway
- ElastiCache + AOSS in private subnets only — no public reachability
- ECS Fargate task in private subnet, egress through NAT for ECR pulls

---

## Container hardening

The orchestrator container runs `--user root` because it mounts the Docker
socket (legacy lifecycle pattern; replaced by ECS for sub-agent management).
The ECS sub-agent task runs as **uid 1001** with no host privileges, no
capabilities, and no privileged-mode flag.

### Document validation
- MIME-type magic-byte detection on every upload
- Extension MUST match detected MIME (PDF, DOCX, PPTX, TXT, MD, JPG, PNG)
- Hard size limits: 25 MB (WhatsApp), 50 MB (admin)
- Executable / archive / script formats rejected outright

### Webhook tokens (destructive command confirmation)
- 32-byte random tokens via `secrets.token_urlsafe`
- SHA-256 hashed at rest in DynamoDB
- 15-minute TTL, single-use (deleted on first validation)
- Constant-time comparison to prevent timing attacks

---

## WhatsApp session

- Baileys session blob stored in S3 under the `sessions/` prefix
  (`nanoclaw/app-config:WHATSAPP_SESSION_S3_PREFIX`)
- Survives EC2 restart — no QR re-pair on routine ops
- QR code only displayed inside the admin dashboard (Basic-auth gated)
- Failed scan attempts logged to CloudWatch
- WhatsApp invalidates sessions roughly every 14 days of inactivity — the
  admin sees a `Connection closed` log line and re-pairs through the dashboard

---

## Audit logging

Every data-access operation logs:

- userId
- operation (read / write / delete / search)
- resource (table / bucket / index)
- timestamp (ISO 8601)
- outcome (success / failure + error class)

Logs go to CloudWatch (`/nanoclaw/orchestrator`, `/ecs/nanoclaw-sub-agent`)
with one-year retention. Admin logins and DSAR requests are logged at INFO
level so they're queryable through CloudWatch Insights.

---

## PDPA compliance (Singapore)

- **Region:** all data resides in `ap-southeast-1`
- **Consent:** collected on first contact via WhatsApp confirmation
- **Annual reminder:** at 11 months, prompt for re-consent
- **Right to access:** `exportUserData()` produces a DSAR export
- **Right to erasure:** `/forget` → `deleteAllUserData()` removes the user's
  rows from all four DynamoDB tables, all `users/{userId}/...` S3 objects, and
  all OpenSearch chunks tagged with that userId. Completes within 24 h.
- **Notification:** in the event of a confirmed breach affecting personal
  data, the DPO is notified within 24 h, severity assessed within 48 h,
  affected users notified via WhatsApp within the PDPA's 72-hour window.

---

## CI/CD security

- GitHub Actions uses **OIDC** (`sts:AssumeRoleWithWebIdentity`) — no static
  AWS keys live in GitHub.
- The deploy IAM role's trust policy binds `sub` to the specific repo and
  branch refs.
- `tfsec` runs in CI; tfsec findings gate the deploy.
- Pre-push and commit-msg hooks lint commit messages locally
  (`--no-verify` may be required on Windows hosts).

---

## Incident response

### Auto-rollback
The production rail (`deploy.yml`) monitors `/health` for 10 minutes after
deploy. On failure, it reverts to the previous tag stored in SSM Parameter
Store and pages the on-call channel.

### Manual recovery paths
- **Disk full on EC2** → see `~/.hermes/skills/devops/aws-ec2-disk-full-recovery/SKILL.md`
- **TLS cert expired** → see `docs/runbooks/caddy-tls-setup.md`
- **WhatsApp re-pair** → admin dashboard QR; if dashboard offline, SSH and
  delete the session blob, restart, scan fresh QR from journal

---

## Findings register
See `docs/security-assessment.md` for the live findings register, including
accepted risks (Basic auth over HTTP, 22/3000 open to 0/0).
