# Security

## Threat model

Clawd is a multi-user WhatsApp / Telegram AI assistant. Main attack surfaces:
untrusted inbound text and filenames, the admin dashboard, AWS APIs, the
sub-agent container, and LLM prompt injection.

## Controls in place

**Input** — attachment filenames validated (`isSafeAttachmentName()` rejects
`..` and absolute separators before `path.join`); URL regex strips trailing
brackets.

**Secrets** — all credentials in Secrets Manager `nanoclaw/app-config`; never
in git, never baked into images. OneCLI injects them at request time.
`ADMIN_PASS` is fixed; `SESSION_TOKEN` / `CSRF_TOKEN` are derived
deterministically via HMAC(ADMIN_PASS) so sessions survive restarts.

**Network** — ECS tasks have no public IP (outbound via NAT only); Redis and
AOSS are VPC-internal with IAM auth; EC2 SG exposes only port 3000 (locked down
after C9).

**IAM** — least-privilege task/instance roles (DynamoDB `nanoclaw-*`, S3
`nanoclaw-data-*`, AOSS, Bedrock InvokeModel, Secrets Manager GetSecretValue).

**Rate limiting** — per-user Redis token bucket, router-side backpressure, and
a 45-second hard processing timeout.

**PDPA** — consent gate on first message; `/forget` deletes all user data
(DynamoDB + AOSS); `/forget-url` removes one URL; `/privacy` explains handling.

## Known gaps

- Admin dashboard has no TLS yet (**C9** — Caddy + Let's Encrypt pending)
- EC2 SG not yet restricted to known IPs (**C10**, after C9)
- No WAF on the admin endpoint
- LLM prompt-injection defence is limited to persona guardrails

## Reporting

Private project — report issues directly to the repo owner.
