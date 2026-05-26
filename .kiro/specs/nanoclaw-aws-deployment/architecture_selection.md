# Architecture Selection: NanoClaw AWS Deployment

## Recommended Architecture: Monolithic Orchestrator + Isolated Agents (with Data Gateway Module)

### Rationale

Candidate A achieves the lowest evolvability cost (1.8 components per new REQ) and maps directly to the existing NanoClaw v2 codebase, minimizing implementation risk. The god-object score (45%) is acceptable for a 50-100 user system where operational simplicity and debuggability outweigh independent scalability. We incorporate Candidate C's Data Gateway as an internal module to centralize data isolation enforcement (INV-1) without adding network hops. The trade-off is reduced horizontal scalability — the orchestrator is a single point of failure, but vertical scaling (r6i.4xlarge → r6i.8xlarge) covers the target capacity.

### Components

| Component | Owned State | Responsibility |
|-----------|-------------|----------------|
| Orchestrator (Node.js on EC2) | whatsapp_session_state, rate_limit_counters, container_state, notification_schedule | Message routing, container lifecycle, scheduling, WhatsApp bridge (Baileys), admin API, rate limiting |
| Data Gateway (internal module) | user_id_filter enforcement, audit_log | Centralized data access layer — enforces user isolation on ALL queries, handles audit logging and redaction |
| Sub-Agent Container (FastAPI per user) | In-flight processing state | Process messages, call Bedrock LLM, assemble RAG context, generate slides, handle document ingestion |
| ElastiCache Redis | queue_messages | Async message passing between orchestrator and sub-agents, dead letter queue |
| DynamoDB | chat_history, user_preferences, webhook_token, system_errors | Persistent structured data with TTL enforcement |
| OpenSearch Serverless | document_chunks, embedding_vectors | Vector similarity search + BM25 keyword search |
| S3 | document_files, generated_pptx, whatsapp_session_backup | Object storage for files, slides, session persistence |
| Secrets Manager | secrets | Credential storage with 90-day rotation |
| CloudWatch | health_status, alert_events, system_errors | Metrics, logs, alerts, dashboards |
| ECR | container_image_tag | Container image registry |

### Information Flow

| From \ To | Orchestrator | Sub-Agent | Redis | Data Gateway | DynamoDB | OpenSearch | S3 | Secrets Mgr | CloudWatch |
|-----------|-------------|-----------|-------|-------------|----------|-----------|-----|-------------|------------|
| Orchestrator | — | → (spawn/kill/msg) | → ← | → ← | | | → ← | → | → |
| Sub-Agent | ← (status) | — | → ← | → ← | | | | | → |
| Data Gateway | | | | — | → ← | → ← | → ← | | → |
| External (WA) | → | | | | | | | | |

### Requirement Allocation

| Requirement | Component(s) |
|-------------|--------------|
| REQ-1.1 | Orchestrator (EC2 host config) |
| REQ-1.2 | Orchestrator (container manager, Docker flags) |
| REQ-1.3 | Secrets Manager |
| REQ-2.1 | Data Gateway → DynamoDB |
| REQ-2.2 | Data Gateway → OpenSearch Serverless |
| REQ-2.3 | Data Gateway → S3 |
| REQ-3.1 | Sub-Agent (Bedrock client) |
| REQ-3.2 | Sub-Agent (embedding pipeline) |
| REQ-3.3 | Sub-Agent (RAG assembly via Data Gateway) |
| REQ-4.1 | Orchestrator (Baileys handler) |
| REQ-4.2 | ElastiCache Redis |
| REQ-4.3 | Orchestrator (scheduler + container manager) |
| REQ-5.1 | Sub-Agent |
| REQ-5.2 | Sub-Agent + Data Gateway |
| REQ-5.3 | Sub-Agent + Data Gateway (S3) |
| REQ-6.1 | CloudWatch + Orchestrator (metric emission) |
| REQ-6.2 | CloudWatch |
| REQ-6.3 | Orchestrator (health probes) |
| REQ-7.1 | Data Gateway (single enforcement point) |
| REQ-7.2 | Terraform (VPC/SG/NACL) |
| REQ-7.3 | Data Gateway + Sub-Agent |
| REQ-8.1 | Terraform |
| REQ-8.2 | GitHub Actions + ECR |
| REQ-8.3 | ECR |
| REQ-9.1 | Orchestrator + Sub-Agent + Redis (latency path) |
| REQ-9.2 | Orchestrator (capacity management) |
| REQ-9.3 | Orchestrator (scaling config) |

### Key Design-Induced Invariants

1. **Data Gateway is the sole path to persistence** — Sub-agents cannot directly access DynamoDB, OpenSearch, or S3. All data operations route through the Data Gateway module which injects userId filters and logs access.
2. **One container per user, one user per container** — The orchestrator enforces a 1:1 mapping. No container ever processes messages for multiple users.
3. **Redis is the only communication channel** — Orchestrator and sub-agents never communicate directly (no HTTP calls, no shared filesystem). Redis queue is the sole IO surface.
4. **Secrets are runtime-injected via IAM** — No secrets in environment variables, Docker labels, or configuration files. The EC2 instance role + Secrets Manager SDK handle all credential access.

### Alternatives Considered

| Candidate | Strength | Weakness | Why Not Selected |
|-----------|----------|----------|-----------------|
| B: Event-Driven Microservices | Independent scaling, zero server management, pay-per-use | Higher cross-cutting invariant % (42%), INV-1 enforcement across 3+ services, complex debugging, higher evolvability cost (2.4) | Over-engineered for 50-user target; Baileys requires persistent WebSocket incompatible with Lambda |
| C: Layered + Data Gateway | Best INV-1 enforcement (single point), lowest cross-cutting % | Extra network hop on every data operation, more complex deployment | Gateway pattern adopted as internal module in Candidate A instead |

### Metrics Summary

| Metric | Selected (A+Gateway) | Alt A (pure) | Alt B (Event-Driven) | Alt C (Layered) |
|--------|---------------------|--------------|---------------------|-----------------|
| Cross-cutting reqs % | 8% | 12% | 16% | 8% |
| Cross-cutting invariants % | 25% | 33% | 42% | 25% |
| Flow density | 0.18 | 0.21 | 0.18 | 0.16 |
| God object score | 40% | 45% | 18% | 30% |
| Sync cycles | 0 | 0 | 0 | 0 |
| Max fan-in | 4 | 4 | 5 | 4 |
| Max fan-out | 5 | 5 | 4 | 4 |
| Evolvability cost | 1.6 | 1.8 | 2.4 | 1.6 |
