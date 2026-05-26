# NanoClaw Requirements

## Product Vision

NanoClaw is a cloud-native multi-user WhatsApp AI assistant for corporate users
in Singapore. It provides personalized AI assistance through WhatsApp messaging,
featuring document processing, knowledge retrieval (RAG), and automated daily
notifications.

---

## Target Users

Corporate employees who need:

- Quick access to corporate knowledge via WhatsApp
- Document processing and searchable knowledge base
- Automated daily briefings
- Slide generation from document context

---

## Success Criteria

| Metric | Target | Measurement |
|--------|--------|-------------|
| P95 Response Latency | ≤ 30 seconds | CloudWatch Application Insights |
| Document Extraction Accuracy | ≥ 98% | Benchmark against 100 samples |
| OCR Accuracy (scanned PDFs) | ≥ 80% | Benchmark against 50 samples |
| Monthly Uptime | 99.5% (≤ 3.6h downtime/month) | CloudWatch availability |
| Cross-User Data Leakage | Zero incidents | Quarterly security audits |
| Concurrent User Capacity | ≥ 50 users | k6 load testing |

---

## Architecture Decisions

### Cloud-First (AWS)

All infrastructure runs on AWS managed services. No local deployments, no
self-hosted databases, no local Redis. This ensures:

- Consistent environment across dev/staging/production
- Managed scaling and failover
- Compliance with data residency (Singapore region)

### Per-User Container Isolation

Each user gets their own Docker container (FastAPI sub-agent). This provides:

- Complete filesystem and network isolation between users
- Independent resource limits (512MB RAM, 50% CPU)
- No shared state that could leak between users

### Redis as Message Bus

ElastiCache Redis provides async communication between orchestrator and sub-agents:

- Decouples message handling from processing
- Enables graceful degradation under load
- Dead letter queue for failed messages (max 3 retries)
- Backpressure at 100 messages per user

### Hybrid RAG Search

OpenSearch Serverless with 70% vector + 30% BM25 keyword matching:

- Vector search catches semantic similarity
- BM25 catches exact term matches
- Mandatory userId filter prevents cross-user data access
- 1536-dimension embeddings via Bedrock Titan v2

### WhatsApp via Baileys

Unofficial WhatsApp Web protocol (Baileys v7). ToS risk acknowledged:

- Dedicated WhatsApp number (not personal)
- Rate limiting to stay below suspicious thresholds
- Session persisted to S3 for VM restart recovery
- Contingency: migrate to WhatsApp Business API (2-week effort)

### Secrets Manager for Config

All runtime configuration loaded from AWS Secrets Manager:

- No secrets in environment variables or config files
- 5-minute cache with auto-refresh
- Supports credential rotation without restart

---

## Non-Goals

- Local/self-hosted deployment mode
- Multi-cloud support
- Web dashboard for end users (admin only)
- Voice message processing (text only)
- Group chat support (DMs only)

---

## Compliance

### PDPA (Singapore Personal Data Protection Act)

- Consent collection before storing personal data
- Data Subject Access Requests via `/export` command
- Right to be Forgotten via `/deleteaccount` command
- 72-hour breach notification procedure
- All data stored in ap-southeast-1 (Singapore)
- Annual consent renewal reminders
- Quarterly security penetration testing

### Data Retention

| Data Type | Retention | Justification |
|-----------|-----------|---------------|
| Chat messages | 90 days | Conversation continuity |
| User preferences | Until deletion | Service functionality |
| Uploaded documents | Until deletion | User-controlled KB |
| System errors | 30 days | Debugging |
| Audit logs | 1 year | Compliance |
