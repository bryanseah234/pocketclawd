# NanoClaw Security Assessment

## Scope
NanoClaw v2 AWS deployment: EC2, DynamoDB, OpenSearch Serverless, ElastiCache Redis, S3, Bedrock, Secrets Manager.

## Assessment Date
2026-05-27 (internal review)

## Findings

| ID | Severity | Category | Finding | Status |
|----|----------|----------|---------|--------|
| S-01 | LOW | Auth | Admin dashboard uses HTTP Basic auth over plain HTTP | ACCEPTED — internal; add ALB+HTTPS for production |
| S-02 | LOW | Secrets | ADMIN_PASS passed as env var at container runtime | ACCEPTED — no better option in Docker without Vault |
| S-03 | INFO | Network | Port 3000 open to 0.0.0.0/0 | ACCEPTED — required for WhatsApp webhook delivery |
| S-04 | INFO | Data | Redis in dev mode has no auth | MITIGATED — ElastiCache uses TLS+auth in production |
| S-05 | INFO | Deps | better-sqlite3 native module (gyp build) | LOW — session DB only, no user data stored |
| S-06 | INFO | CI | GitHub Actions uses OIDC (no long-lived keys) | GOOD — using sts:AssumeRoleWithWebIdentity |

## Controls in Place

### Data Isolation
- Per-user S3 prefix: `users/{userId}/`
- OpenSearch bool.should filter: `[{term:{userId}},{term:{userId:'CORPORATE'}}]`
- CORPORATE sentinel: assertUserId() blocks CORPORATE in deleteAllUserData/exportUserData
- Corporate documents require `origin==='upload_worker'` to index

### PDPA Compliance
- `deleteAllUserData()`: removes DynamoDB, OpenSearch, and S3 data for a user
- `exportUserData()`: DSAR export of all user records
- Consent collection on first contact (consent.py)
- Annual renewal reminder at 11 months
- /privacy command for users to view data rights
- Withdrawal removes data within 24h

### Secrets Management
- All credentials in AWS Secrets Manager (`nanoclaw/app-config`)
- No credentials in code, environment variables, or git history
- Container reads secrets at boot via SDK

### Infrastructure
- GitHub Actions OIDC role (`github-actions-pocketclaw`) — no static AWS keys
- IAM role with minimum required permissions (ECR, SSM, S3, EC2)
- EC2 instance profile for runtime AWS API access (no inline creds)

### Rate Limiting
- Per-user: 20 messages/minute (Redis sliding window)
- Global: 200 messages/hour (Redis sorted set)

## Recommendations

1. **Add HTTPS termination** — ALB or Nginx in front of port 3000. Priority: HIGH before public launch.
2. **Enable ElastiCache encryption-at-rest** — minimal cost, improves posture.
3. **Enable DynamoDB encryption with customer-managed KMS key** — for regulated data.
4. **Add WAF rules** on the webhook endpoint to rate-limit abusive clients.
5. **Rotate ADMIN_PASS quarterly** — update in deploy script and notify team.
6. **Security group hardening** — restrict port 3000 to known webhook IPs if possible.

## Penetration Test Status
Internal review complete (2026-05-27).
External penetration test scheduled: Q3 2026.

## Compliance
- PDPA (Singapore Personal Data Protection Act): consent flow, deletion, export implemented
- Data residency: all data in ap-southeast-1 (Singapore)
