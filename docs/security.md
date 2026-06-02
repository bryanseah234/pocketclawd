# Security

## Threat model

Clawd is a multi-user WhatsApp / Telegram AI assistant. Main attack surfaces:

- Inbound messages: untrusted user text, media filenames
- Admin dashboard: basic auth, no TLS until C9
- AWS APIs: IAM, Secrets Manager, S3, DynamoDB, AOSS
- Sub-agent container: process isolation, no root
- LLM prompt injection: user messages in LLM context

## Controls in place

### Input sanitisation

- Attachment filenames validated with isSafeAttachmentName() -- rejects
  paths containing .. or absolute path separators before path.join
- URL regex strips trailing brackets to prevent truncated URL attacks

### Secrets

- All credentials in AWS Secrets Manager nanoclaw/app-config
- Never in env vars committed to git, never baked into container images
- OneCLI gateway injects secrets into containers at request time
- ADMIN_PASS is fixed (do not rotate -- hardcoded session tokens would break)
- SESSION_TOKEN is deterministic: sha256(ADMIN_PASS + 'session')[:32]

### Network

- ECS tasks: no public IP, outbound via NAT gateway only
- EC2 security group: port 3000 open for admin (restrict post-C9)
- Redis: internal VPC only, no public endpoint
- AOSS: VPC endpoint + IAM auth only

### IAM

- ECS task role: DynamoDB r/w (nanoclaw-* tables), S3 r/w (nanoclaw-data-*),
  AOSS access, Bedrock InvokeModel, Secrets Manager GetSecretValue
- EC2 instance role: same + SSM for remote access
- IAM user BedrockAPIKey-1gi8: admin access, key expires -- rotate before expiry

### Rate limiting

- Per-user rate limiter in sub-agent (Redis token bucket)
- Backpressure check before queue write in router.ts
- 45-second hard timeout on sub-agent message processing

### PDPA

- Consent gate on first message from every user
- /forget command deletes all user data (DynamoDB + AOSS)
- /forget-url removes a specific URL from the knowledge base
- /privacy explains data handling

## Known gaps

- Admin dashboard has no TLS (C9 pending -- Caddy + Let's Encrypt)
- EC2 security group not yet restricted to SG IPs (C10 pending, after C9)
- No WAF on the admin endpoint
- No systematic defence against LLM prompt injection beyond persona guardrails

## Vulnerability reporting

Private project. Report issues directly to the repo owner.
