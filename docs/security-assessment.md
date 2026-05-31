# Clawd / NanoClaw — Security Assessment

## Scope
Clawd / NanoClaw cloud deployment in `ap-southeast-1`. Components in scope:
EC2 r6i.4xlarge orchestrator, ECS Fargate sub-agent, DynamoDB (4 tables),
OpenSearch Serverless, ElastiCache Redis, S3, Bedrock, Secrets Manager, ECR,
CloudWatch.

## Assessment date
2026-05-29 (internal review, post-W11 deploy `9abee18`).
External penetration test scheduled: Q3 2026.

---

## Findings register

| ID | Severity | Category | Finding | Status |
|----|----------|----------|---------|--------|
| S-01 | LOW | Auth | Admin dashboard uses HTTP Basic auth over plain HTTP | ACCEPTED — internal use only; HTTPS via Caddy planned (runbook ready) |
| S-02 | LOW | Secrets | `ADMIN_PASS` passed as env var at container start | ACCEPTED — alternative is reading from Secrets Manager at boot, planned post-Caddy |
| S-03 | INFO | Network | EC2 SG allows :22, :3000 from 0.0.0.0/0 | ACCEPTED short-term — required during build; lock to admin IP set in C-04 |
| S-04 | INFO | Data | ElastiCache Redis (replication group `nanoclaw-redis-rg`) runs with transit encryption (`redis_tls=true`) + AUTH token | ACCEPTED — cluster is private to the VPC, no public reachability |
| S-05 | INFO | Deps | `better-sqlite3` native module compiles via gyp | LOW — used only for legacy session DB; no user data stored in SQLite |
| S-06 | INFO | CI | GitHub Actions uses OIDC, no static AWS keys | GOOD — `sts:AssumeRoleWithWebIdentity` |
| S-07 | LOW | Container | Orchestrator runs `--user root` to mount `/var/run/docker.sock` | ACCEPTED — needed for legacy lifecycle; sub-agent (the higher-risk surface) runs uid 1001 with no privileges |
| S-08 | INFO | IAM | EC2 + ECS task roles include `aoss:APIAccessAll` | NEEDED — without it AOSS returns opaque 403; data-access policy alone is insufficient |
| S-09 | LOW | Audit | A previous version of `docs/prd-gap-analysis.md` checked the admin password into git history | REMEDIATED — purged from current docs in commit `9abee18+1`; rotate before any external sharing |

> S-09 was identified during the W12 doc refresh: an earlier audit doc
> committed a literal `admin / NcLaw$2026!xK9m` to the repo. Live password
> should be rotated and the previous tree blob redacted before any
> external code sharing or open-sourcing.

---

## Controls in place

### Data isolation (the primary control)
- Per-user S3 prefix `users/{userId}/`
- Mandatory `userId` filter on every OpenSearch query; `bool.should` adds the
  `CORPORATE` sentinel for opted-in shared corpus
- DynamoDB `userId` is the partition key on every table; cross-partition
  reads are physically impossible
- DataGateway's `assertUserId()` blocks `CORPORATE` in `deleteAllUserData()`
  and `exportUserData()` so a user can't wipe shared documents through their
  own DSAR flow
- Document upload to corporate corpus requires `origin === 'upload_worker'`
  metadata — direct user uploads can't be routed to shared

### PDPA compliance (Singapore)
- All data resides in `ap-southeast-1`
- Consent collected on first contact via WhatsApp confirmation
- Annual reminder at 11 months
- `/privacy` exposes the user's data rights
- `/forget` triggers `deleteAllUserData()` which removes every row across
  the four DynamoDB tables, every `users/{userId}/...` S3 object, every
  OpenSearch chunk tagged with that userId — completed within 24h
- `exportUserData()` produces a DSAR export (JSON + signed S3 manifest)

### Secrets management
- AWS Secrets Manager — `nanoclaw/app-config`, `nanoclaw/google-secrets`
- Boot-time read with 5-min cache TTL (auto-refresh)
- No long-lived AWS keys in env, code, GitHub, or CI
- Service-to-service auth via IAM roles (EC2 instance profile + ECS task role)
- Admin password is the one secret currently passed as a container env var
  (rotation procedure: edit container start command + restart)

### Webhook tokens (destructive command confirmation)
- 32-byte random tokens via `secrets.token_urlsafe`
- SHA-256 hashed at rest in DynamoDB
- 15-minute TTL, single-use (deleted on first validation)
- Constant-time comparison

### Container hardening
- ECS sub-agent task uses uid 1001, no capabilities, no privileged mode
- Orchestrator uses `--user root` for Docker socket mount (legacy lifecycle);
  base image is `node:22-alpine` with only required packages
- Document uploads validated by MIME magic-byte; extension must match;
  hard size limits 25 MB (WhatsApp) / 50 MB (admin); executable formats
  rejected outright

### Audit logging
- Every read / write / delete / search logs userId + operation + resource +
  timestamp + outcome to CloudWatch
- One-year retention on audit-tagged streams
- Admin logins, DSAR requests, WhatsApp re-pairs all logged at INFO level

### CI/CD
- OIDC for GitHub Actions; trust policy bound to repo + branch refs
- `tfsec` runs in CI; findings surface in PR
- `pnpm audit` and `pip-audit` runs on every CI cycle (advisory only;
  no auto-block)

---

## Hardening backlog

The following are acknowledged gaps with planned remediation:

| Item | Priority | Owner | Target |
|---|---|---|---|
| HTTPS via Caddy + Let's Encrypt | P1 | Bryan | Post-W12 |
| Lock SG ingress to admin IP set | P1 | Bryan | Concurrent with HTTPS |
| Rotate admin dashboard password (S-09 fallout) | P0 | Bryan | Before external sharing |
| Move ADMIN_PASS to Secrets Manager (read at boot) | P2 | Bryan | After HTTPS |
| External penetration test | P2 | TBD | Q3 2026 |
| WAF on the Caddy front-door | P3 | TBD | Post-pentest |
| k6 load test (50 concurrent users) | P2 | Bryan | Before GA |

---

## Threat-model deltas vs the original PRD

The PRD assumed per-user Docker isolation as the primary security control.
The deployed build trades that for shared-task economics + data-layer
isolation. The new threat model:

- **Process compromise of the sub-agent** has cross-user blast radius now,
  whereas previously each user's sub-agent was its own process. Mitigation:
  the sub-agent never holds long-lived per-user state (everything is
  re-fetched from DynamoDB / OpenSearch per message); a compromised process
  could exfiltrate only what it could reach via the DataGateway, and
  DataGateway operations are bounded by IAM policy rather than process
  trust.
- **Shared queue contention** — a flood from one user could starve others.
  Per-user rate limits (20 msg/min) plus the global hourly limit (200/h) is
  the current backstop; per-user backpressure (max 100 queued) prevents
  unbounded growth.

The data-layer isolation is rigorously enforced and is verified by
quarterly access-pattern audits. Process-level isolation can be reinstated
later (one ECS task per user) if a future threat model demands it.

---

## Compliance summary

- **PDPA (Singapore):** consent flow, `/privacy`, DSAR via
  `exportUserData`, deletion via `/forget` → `deleteAllUserData`, 24h SLA,
  apse1 residency
- **Encryption:** at-rest AES-256 (KMS-auto) on DynamoDB, S3, OpenSearch,
  EBS; in-transit TLS 1.2+ to all AWS endpoints; ElastiCache TLS off but
  private to VPC
- **Retention:** 90 days on chat history (DDB TTL); 1 year on audit logs;
  35 days DDB PITR; S3 versioning forever (storage-class transition rules)
- **Breach notification:** DPO within 24h of confirmed breach; severity
  assessed within 48h; PDPA's 72-hour user notification window honoured

## External pen test
Scheduled Q3 2026. Findings will be added to this register as they're
delivered.
