# NanoClaw Security Model

## Overview

NanoClaw enforces security through multiple layers: container isolation,
data isolation via userId enforcement, secrets management, and network controls.

---

## Data Isolation (Critical)

Every persistence operation goes through the DataGateway, which enforces userId
on ALL operations. Cross-user access is impossible by construction:

| Layer | Enforcement |
|-------|-------------|
| DynamoDB | userId is the partition key — queries physically cannot cross partitions |
| OpenSearch | Mandatory `{ term: { userId } }` filter on every search query |
| S3 | Key prefix validation + path traversal rejection (`../` blocked) |
| Redis | Per-user queue keys (`queue:agent:{userId}:inbound`) |
| Containers | Each user runs in isolated Docker container (separate PID/network/fs) |

---

## Container Security

### Hardening

- **Non-root user** (UID 1000)
- **Read-only root filesystem** (tmpfs for writable areas)
- **All Linux capabilities dropped**
- **Seccomp filtering** (minimal syscall set)
- **No new privileges** (prevents escalation)
- **Resource limits**: 512 MB RAM, 50% CPU, 100 PIDs, 2 GB disk

### Network Isolation

Each sub-agent container operates in its own network namespace:

- Can only communicate with orchestrator via management network
- Outbound access to AWS services only (Bedrock, S3, etc.)
- No inter-container communication possible

---

## Secrets Management

### AWS Secrets Manager

All secrets stored in `nanoclaw/app-config` with:

- 5-minute cache + auto-refresh timer
- Supports credential rotation without restart
- IAM role-based access (no long-lived keys)

### Secret Categories

| Secret | Rotation | Access |
|--------|----------|--------|
| Redis password | 90 days (automated) | Orchestrator only |
| DynamoDB (via IAM) | N/A (Managed Identity) | Orchestrator + sub-agents |
| OpenSearch (via IAM) | N/A (Managed Identity) | Orchestrator only |
| S3 (via IAM) | N/A (Managed Identity) | Orchestrator + sub-agents |
| Bedrock (via IAM) | N/A (Managed Identity) | Sub-agents only |
| Admin dashboard password | 90 days | Admin users |

### Sub-Agent Secret Injection

Secrets are passed to containers as environment variables at creation time.
They are NEVER stored in Docker images or written to disk inside containers.

---

## WhatsApp Security

### Session Management

- Baileys session persisted to S3 (`sessions/` prefix)
- Session restored on VM restart without QR re-scan
- QR code displayed only in admin dashboard (Basic Auth protected)
- QR codes expire after 5 minutes
- Failed scan attempts logged for security monitoring

### Rate Limiting

- 20 messages/minute per user
- 200 messages/hour global
- Exceeding limits → messages queued (not dropped)
- Rate limit state in Redis (auto-expires)

---

## Document Security

### Upload Validation

1. MIME type validation via magic byte detection
2. Extension must match detected MIME type
3. Maximum file size: 25 MB (WhatsApp) / 50 MB (admin dashboard)
4. Executable files and archives blocked

### Save Confirmation (Webhook Tokens)

- Cryptographically random tokens (32 bytes, `secrets.token_urlsafe`)
- SHA-256 hashed before storage in DynamoDB
- 15-minute TTL (auto-expired)
- One-time use (deleted after validation)
- Constant-time comparison (prevents timing attacks)

---

## Network Security

### EC2 Security Group

| Direction | Port | Source | Purpose |
|-----------|------|--------|---------|
| Inbound | 443 | Admin IPs | Admin dashboard |
| Inbound | 22 | Admin IPs | SSH access |
| Outbound | 443 | AWS services | API calls |
| Outbound | 5222 | WhatsApp servers | Baileys connection |
| Deny | All other | * | Default deny |

### No Public API

The system has no public-facing API. All user interaction is via WhatsApp
(outbound connection from the EC2 instance). The admin dashboard is
restricted to specific IP addresses.

---

## Audit Logging

All data access is logged to CloudWatch with:

- userId
- Operation type
- Resource accessed
- Timestamp (ISO 8601)
- Success/failure

Audit logs retained for 1 year. Access restricted to authorized personnel.

---

## Incident Response

### Breach Notification (PDPA 72-Hour Rule)

1. Incident reported to DPO within 24 hours
2. Severity assessment within 48 hours
3. Affected users notified via WhatsApp within 72 hours
4. PDPC notified if required

### Automatic Rollback

Production deployments include 10-minute health monitoring. If health checks
fail, automatic rollback to previous image tag via SSM Parameter Store.
