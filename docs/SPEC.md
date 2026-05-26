# NanoClaw Technical Specification

## System Identity

NanoClaw is a cloud-native multi-user WhatsApp AI assistant deployed on AWS.
Users interact via WhatsApp; the system provides AI-powered responses with
document processing, knowledge retrieval (RAG), and automated daily notifications.

**Target:** 50+ concurrent users, P95 latency ≤ 30s, 99.5% uptime.

---

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Orchestrator | Node.js 22 + TypeScript | Message routing, container lifecycle, admin UI |
| Sub-Agent | Python 3.11 + FastAPI | Per-user AI processing, document ingestion |
| WhatsApp | Baileys v7 (rc.9) | WhatsApp Web protocol (unofficial) |
| LLM | AWS Bedrock (Claude 3.5 Sonnet) | AI responses |
| Embeddings | AWS Bedrock (Titan Embed v2) | 1536-dim vectors for RAG |
| Vector Search | OpenSearch Serverless | Hybrid search (knn + BM25) |
| Database | DynamoDB | Chat history, preferences, tokens |
| Storage | S3 | Documents, staging, exports |
| Queue | ElastiCache Redis | Async orchestrator ↔ sub-agent messaging |
| Secrets | Secrets Manager | Runtime config, credential rotation |
| Monitoring | CloudWatch | Logs, metrics, alerts |
| Container Registry | ECR | Docker images (orchestrator + agent) |
| Infrastructure | Terraform | All AWS resources as code |
| CI/CD | GitHub Actions | Automated build → test → deploy pipeline |

---

## Message Queue Protocol

Communication between orchestrator and sub-agents uses Redis Lists (LPUSH/BRPOP).

### Key Patterns

```
queue:agent:{userId}:inbound     — Orchestrator → Sub-Agent
queue:orchestrator:responses      — Sub-Agent → Orchestrator
queue:dlq:{userId}               — Dead letter queue per user
nanoclaw:uploads:pending          — Upload worker pending list
queue:orchestrator:data_gateway   — Sub-Agent → DataGateway requests
```

### Message Shape

```typescript
interface QueueMessage {
    id: string;
    userId: string;
    type: string;        // 'chat' | 'document_upload' | 'command'
    payload: Record<string, unknown>;
    timestamp: string;   // ISO 8601
    retryCount?: number;
}
```

### Backpressure

Queue depth > 100 messages per user triggers backpressure (new messages rejected
with a "busy" response to the user). DLQ retries up to 3 times with the same
message before permanent failure.

---

## Document Processing Pipeline

### Supported Formats

| Format | Extractor | Notes |
|--------|-----------|-------|
| PDF | PyPDF2 + pytesseract OCR fallback | Scanned pages use OCR |
| DOCX | python-docx | Paragraph extraction |
| XLSX | openpyxl | Cell values + sheet names |
| PPTX | python-pptx | Text from shapes + notes |
| CSV | pandas | Header-aware formatting |
| TXT/MD | Built-in | UTF-8 decode |
| Images | pytesseract / GPT-4o Vision | OCR or vision description |

### Chunking

- **Strategy:** Recursive character splitter
- **Chunk size:** 512 tokens
- **Overlap:** 50 tokens
- **Tokenizer:** tiktoken cl100k_base
- **Separators:** `\n\n` → `\n` → `.` → ` ` → ``

### Embedding

- **Model:** Amazon Titan Embed Text v2 (`amazon.titan-embed-text-v2:0`)
- **Dimensions:** 1536
- **Batch size:** 50 chunks per API call
- **Retry:** Exponential backoff (1s, 2s, 4s, 8s, 16s), max 5 retries

### Indexing (OpenSearch)

```json
{
  "id": "keyword",
  "userId": "keyword",
  "docType": "keyword",
  "content": "text (BM25)",
  "contentVector": "knn_vector (1536, cosinesimil, nmslib/hnsw)",
  "filename": "keyword",
  "pageNumber": "integer",
  "chunkIndex": "integer",
  "uploadedAt": "date"
}
```

---

## Data Isolation Model

Every public method on the DataGateway accepts `userId` as the first parameter.
Cross-user access is impossible by construction:

1. **DynamoDB:** userId is the partition key — queries physically cannot cross partitions
2. **OpenSearch:** mandatory `{ term: { userId } }` filter injected programmatically
3. **S3:** key prefix validation (`assertKeyBelongsToUser`) + path traversal rejection
4. **Redis:** per-user queue keys prevent message cross-contamination
5. **Containers:** each user runs in an isolated Docker container (separate PID/network/fs namespace)

---

## Security

### Container Hardening

- Non-root user (UID 1000)
- Read-only root filesystem (tmpfs for writable areas)
- All Linux capabilities dropped
- Seccomp filtering
- Memory limit: 512 MB
- CPU: 50% of one core
- PIDs limit: 100
- Disk quota: 2 GB

### Secrets

All secrets in AWS Secrets Manager with 5-minute cache + auto-refresh.
Sub-agents receive secrets via environment variables at container creation
(never stored in Docker images).

### WhatsApp

- Baileys (unofficial protocol) — ToS risk acknowledged
- Rate limiting: 20 msg/min per user, 200 msg/hour global
- Dedicated WhatsApp number (not personal)
- Session persisted to S3 for VM restart recovery

---

## Scheduled Tasks

| Task | Schedule | Description |
|------|----------|-------------|
| Daily Notification | 9:00 AM SGT | Personalized briefing per user |
| Session Health Check | Hourly | Verify WhatsApp connection |
| DLQ Retry | Every 6 hours | Retry failed document ingestion |
| Secrets Refresh | Every 5 minutes | Reload from Secrets Manager |

---

## Admin Dashboard

HTTP Basic Auth protected web UI at `/admin` (port 3000):

- Real-time WhatsApp QR code for pairing
- System health monitoring (SSE updates every 5s)
- Document upload (multipart → S3 → processing pipeline)
- Container status
- Rate limiting stats
- Quick actions (restart, disconnect, clear limits)

---

## PDPA Compliance

- `/export` command: full data export (chat, docs, prefs) within 24h
- `/deleteaccount` command: complete data deletion within 30 days
- Consent collection on first interaction
- 90-day chat retention (DynamoDB TTL)
- Audit logging (all data access logged to CloudWatch)
- Data residency: all data in ap-southeast-1 (Singapore)
