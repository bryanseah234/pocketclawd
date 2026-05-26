# Implementation Plan: NanoClaw AWS Deployment

## Overview

Deploy NanoClaw v2 to AWS with a Monolithic Orchestrator + Isolated Agents architecture. The implementation converts the existing Node.js/TypeScript host from local SQLite/Postgres backends to managed AWS services (DynamoDB, OpenSearch Serverless, S3, ElastiCache Redis, Bedrock), builds a Python FastAPI sub-agent container, and wires CI/CD via GitHub Actions. Existing Terraform in `infrastructure/terraform/` covers VPC, EC2, DynamoDB, S3, Redis, OpenSearch, ECR, Secrets Manager, and CloudWatch — tasks focus on completing gaps and building the application layer.

## Tasks

- [x] 1. Complete Terraform infrastructure and validate
  - [x] 1.1 Add Terraform remote state backend configuration and tfvars
    - Uncomment and configure the S3 backend in `versions.tf`
    - Create `infrastructure/terraform/backend.tf` with S3 state bucket + DynamoDB lock table resources (bootstrap)
    - Create `infrastructure/terraform/terraform.tfvars` from the example with production values for ap-southeast-1
    - Add Terraform state bucket and lock table as separate bootstrap config
    - _Requirements: REQ-8.1_

  - [x] 1.2 Add missing Terraform resources: Bedrock model access, VPC endpoints for Bedrock/Secrets Manager, and second AZ subnet for Redis
    - Add `aws_vpc_endpoint` interface endpoints for `secretsmanager` and `bedrock-runtime` in `vpc.tf`
    - Add a second private subnet in a different AZ (required by ElastiCache subnet group best practice)
    - Add `aws_bedrock_model_invocation_logging_configuration` if needed
    - Validate all security groups allow only required traffic
    - _Requirements: REQ-1.1, REQ-7.2_

  - [x] 1.3 Add Terraform validation and security scanning to CI
    - Add `terraform fmt -check`, `terraform validate`, and `terraform plan` steps to `.github/workflows/ci.yml`
    - Add tfsec or checkov scanning step for infrastructure security
    - _Requirements: REQ-8.1, REQ-8.2_

  - [x] 1.4 Write Terraform plan smoke test
    - Create `infrastructure/terraform/tests/` with `terraform plan` validation (no apply)
    - Verify all resource references resolve, no circular dependencies
    - _Requirements: REQ-8.1_

- [x] 2. Implement Data Gateway module
  - [x] 2.1 Create Data Gateway core with AWS SDK clients and userId injection
    - Create `src/cloud/data-gateway/index.ts` — main DataGateway class
    - Create `src/cloud/data-gateway/types.ts` — interfaces from design (ChatMessage, DocumentChunk, SearchResult, etc.)
    - Implement constructor that initializes DynamoDB DocumentClient, OpenSearch client (aws4-signed), S3Client
    - Load config from Secrets Manager at startup via `@aws-sdk/client-secrets-manager`
    - Every public method MUST accept `userId` as first param and inject it into all queries
    - _Requirements: REQ-7.1, REQ-2.1, REQ-2.2, REQ-2.3_

  - [x] 2.2 Implement DynamoDB operations in Data Gateway
    - Implement `putChatMessage`, `getChatHistory` (with limit + pagination)
    - Implement `putUserPreference`, `getUserPreference`
    - Implement `createWebhookToken`, `validateWebhookToken` (one-time use + TTL check)
    - Implement TTL calculation: chat_messages 90 days, webhook_tokens 15 min, system_errors 30 days
    - Implement `logSystemError` for the system_errors table
    - All operations use `@aws-sdk/lib-dynamodb` with marshalling
    - _Requirements: REQ-2.1, REQ-5.2_

  - [x] 2.3 Implement OpenSearch operations in Data Gateway
    - Implement `indexDocument` — index a document chunk with userId, contentVector, metadata
    - Implement `hybridSearch` — combine knn vector query (70% weight) with BM25 text query (30% weight), enforce userId filter
    - Implement `deleteUserDocuments` — delete by userId + optional filename filter
    - Use `@opensearch-project/opensearch` with AWS SigV4 signing
    - Create index template with mappings matching design (knn_vector 1536 dims, cosinesimil, nmslib)
    - _Requirements: REQ-2.2, REQ-3.3, REQ-7.1_

  - [x] 2.4 Implement S3 operations in Data Gateway
    - Implement `uploadFile` — stream upload with userId prefix enforcement, SSE-S3
    - Implement `getFile` — stream download with userId prefix validation
    - Implement `listFiles` — list objects under userId prefix
    - Implement `deleteFile` — delete with userId prefix validation
    - Use `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` for multipart uploads > 5MB
    - _Requirements: REQ-2.3, REQ-7.1_

  - [x] 2.5 Implement audit logging and PDPA compliance in Data Gateway
    - Implement `logAccess` — write structured audit log entry to CloudWatch
    - Implement `exportUserData` — gather all user data from DynamoDB + OpenSearch + S3, package as JSON
    - Implement `deleteAllUserData` — delete from all three stores, return DeletionReceipt
    - Audit log entries include: userId, operation, resource, timestamp, success/failure
    - _Requirements: REQ-7.1, REQ-7.3_

  - [x] 2.6 Write property test: Data isolation enforcement (Property 1)
    - **Property 1: Data isolation enforcement**
    - For any two distinct userIds, queries through DataGateway as userA return zero results belonging to userB
    - Mock AWS SDK clients, verify userId filter is always injected
    - Use fast-check with arbitrary user ID generators
    - **Validates: Requirements REQ-7.1, AC-5**

  - [x] 2.7 Write property test: TTL epoch calculation (Property 2)
    - **Property 2: TTL epoch calculation**
    - For any valid creation timestamp, verify TTL = timestamp + 7,776,000s (chat), 900s (webhook), 2,592,000s (errors)
    - Use fast-check with arbitrary date generators
    - **Validates: Requirements REQ-2.1**

  - [x] 2.8 Write property test: PDPA data lifecycle (Property 8)
    - **Property 8: PDPA data lifecycle**
    - After exportUserData, result contains all records; after deleteAllUserData, all queries return empty
    - Mock AWS clients, verify completeness of export and deletion
    - **Validates: Requirements REQ-7.3**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement Redis message queue and rate limiter
  - [x] 4.1 Create Redis message queue module
    - Create `src/cloud/redis-queue/index.ts` — MessageQueue class implementing the design interface
    - Implement `enqueueForAgent`, `dequeueForAgent` using Redis Lists (LPUSH/BRPOP)
    - Implement `enqueueResponse`, `dequeueResponse` for sub-agent → orchestrator flow
    - Implement `moveToDLQ` and `retryFromDLQ` with retry counter tracking
    - Implement `getQueueDepth` and `isBackpressured` (threshold: 100 pending messages)
    - Use `ioredis` package, connect via ElastiCache endpoint from Secrets Manager config
    - _Requirements: REQ-4.2_

  - [x] 4.2 Create rate limiter module
    - Create `src/cloud/rate-limiter/index.ts` — sliding window rate limiter using Redis Sorted Sets
    - Implement per-user limit: 20 messages/minute (ZADD with timestamp scores, ZRANGEBYSCORE to count)
    - Implement global limit: 200 messages/hour
    - Return `RateLimitResult` with allowed/denied status and retry-after header value
    - _Requirements: REQ-4.1_

  - [x] 4.3 Write property test: Rate limiting enforcement (Property 5)
    - **Property 5: Rate limiting enforcement**
    - For any sequence of N messages in 1 minute from one user, first 20 allowed, rest denied
    - For any sequence across all users in 1 hour, first 200 allowed, rest denied
    - Use fast-check with arbitrary message sequences
    - **Validates: Requirements REQ-4.1**

- [x] 5. Implement orchestrator cloud adaptations
  - [x] 5.1 Create Secrets Manager config loader
    - Create `src/cloud/secrets/index.ts` — load and cache secrets from AWS Secrets Manager
    - Implement `loadConfig()` that fetches the `nanoclaw/app-config` secret and parses JSON
    - Cache secrets in memory with 5-minute refresh interval
    - Expose typed config interface matching the secret structure in `secrets.tf`
    - Replace all `.env` file reads with Secrets Manager lookups in production mode
    - _Requirements: REQ-1.3_

  - [x] 5.2 Create CloudWatch structured logger
    - Create `src/cloud/logging/index.ts` — structured JSON logger that writes to CloudWatch Logs
    - Implement log levels: INFO, WARNING, ERROR with different retention (30/60/90 days handled by log group config)
    - Implement sensitive data redaction: mask API keys, tokens, passwords, message content before logging
    - Integrate with existing `src/log.ts` (pino) — add CloudWatch transport
    - Emit custom metrics via `PutMetricData`: ErrorCount, MessageProcessingTime, ActiveContainers
    - _Requirements: REQ-6.1, REQ-6.2_

  - [x] 5.3 Write property test: Log redaction completeness (Property 7)
    - **Property 7: Log redaction completeness**
    - For any log string containing sensitive patterns (API keys, bearer tokens, passwords), redaction replaces all sensitive values with mask
    - Use fast-check to generate strings with embedded sensitive patterns
    - **Validates: Requirements REQ-6.2**

  - [x] 5.4 Adapt WhatsApp session persistence to S3
    - Modify Baileys auth state handling to persist sessions to S3 (`sessions/` prefix) instead of local filesystem
    - Create `src/cloud/session-store/index.ts` — S3-backed auth state store implementing Baileys `AuthenticationState`
    - Implement `saveCreds`, `loadCreds`, `clearCreds` using Data Gateway S3 operations
    - Add hourly health check that verifies session validity and alerts admin via CloudWatch alarm
    - _Requirements: REQ-4.1, REQ-6.3_

  - [x] 5.5 Adapt container manager for cloud deployment
    - Modify `src/container-runner.ts` to pull agent images from ECR instead of local builds
    - Add ECR authentication refresh (token expires every 12 hours)
    - Configure container networking: management network 172.20.0.0/16, per-user subnets
    - Enforce resource limits from design: 512MB memory, 50% CPU, 100 PIDs, 2GB disk, read-only rootfs, drop all caps
    - Add container health monitoring with automatic restart on failure (exit 137 = OOM, backoff on repeated crashes)
    - _Requirements: REQ-1.2, REQ-6.3_

  - [x] 5.6 Implement scheduler service for daily notifications
    - Create `src/cloud/scheduler/index.ts` — cron-based scheduler using node-cron
    - Implement daily notification generation at 9:00 AM SGT (configurable per user from preferences)
    - Route notification through the standard message pipeline (enqueue to Redis → sub-agent processes → response delivered)
    - _Requirements: REQ-4.3_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Build Sub-Agent FastAPI container
  - [x] 7.1 Create FastAPI sub-agent project structure
    - Create `container/sub-agent/` directory with: `pyproject.toml`, `Dockerfile`, `src/main.py`, `src/config.py`
    - Define FastAPI app with health endpoint and message processing endpoint
    - Configure Redis connection for queue polling (receive from orchestrator, send responses back)
    - Implement main loop: poll Redis queue → process message → enqueue response
    - Pin dependencies: `fastapi==0.115.*`, `uvicorn==0.34.*`, `boto3==1.35.*`, `redis==5.2.*`, `pydantic==2.10.*`
    - _Requirements: REQ-5.1_

  - [x] 7.2 Implement Bedrock LLM client with circuit breaker
    - Create `container/sub-agent/src/llm/bedrock_client.py` — Bedrock InvokeModel wrapper
    - Support task-specific temperature: chat 0.5, summarization 0.3, slides 0.8, RAG QA 0.2
    - Enforce max 4096 output tokens per response
    - Implement circuit breaker: closed → open (5 failures or >50% in 60s) → half-open (30s cooldown)
    - Implement retry with exponential backoff (1s, 2s, 4s) up to 3 retries
    - _Requirements: REQ-3.1_

  - [x] 7.3 Implement embedding pipeline
    - Create `container/sub-agent/src/embeddings/pipeline.py` — Bedrock Titan Embeddings client
    - Produce 1536-dimension vectors
    - Implement recursive character splitter: 512 tokens per chunk, 50-token overlap
    - Batch embed 50 chunks per API call with exponential backoff retry (up to 5 retries)
    - _Requirements: REQ-3.2_

  - [x] 7.4 Implement RAG retrieval with hybrid search and reranking
    - Create `container/sub-agent/src/rag/retrieval.py` — hybrid retrieval pipeline
    - Combine 70% vector similarity (cosine, threshold 0.7) + 30% BM25 keyword (normalized)
    - Implement cross-encoder reranking on combined results (use a lightweight model or Bedrock)
    - Return top 3 chunks after reranking with source attribution (filename, page, relevance score)
    - Maintain 30-message conversation history (up to 3000 tokens) for context
    - _Requirements: REQ-3.3_

  - [x] 7.5 Write property test: Document chunking invariants (Property 3)
    - **Property 3: Document chunking invariants**
    - For any input text > 0 length: chunks ≤ 512 tokens, overlap ≈ 50 tokens (±5), concatenation reconstructs original
    - Use Hypothesis with text generation strategies
    - **Validates: Requirements REQ-3.2**

  - [x] 7.6 Write property test: Hybrid retrieval score combination (Property 4)
    - **Property 4: Hybrid retrieval score combination**
    - Combined score = 0.7 × vector_score + 0.3 × normalized_bm25, ordered descending, returns min(3, total)
    - Use Hypothesis with float strategies in valid ranges
    - **Validates: Requirements REQ-3.3**

  - [x] 7.7 Implement document processing pipeline
    - Create `container/sub-agent/src/documents/processor.py` — document ingestion pipeline
    - Implement: upload → text extraction → chunking → embedding → index via Data Gateway
    - Support file types: PDF (text + OCR via pytesseract), DOCX (python-docx), CSV, TXT, images (OCR)
    - Stream uploads to S3 staging prefix, move to documents prefix after processing
    - _Requirements: REQ-5.1_

  - [x] 7.8 Implement webhook token manager and document commands
    - Create `container/sub-agent/src/documents/commands.py` — /list, /delete, /update commands
    - Implement webhook-based save confirmation with SHA-256 hashed one-time tokens (15-min expiry)
    - Implement auto-save mode (read from user preferences in DynamoDB)
    - _Requirements: REQ-5.2_

  - [x] 7.9 Write property test: Webhook token lifecycle (Property 6)
    - **Property 6: Webhook token lifecycle**
    - Token valid within 15 min on first use, invalid on second use, invalid after 15 min
    - Use fast-check (or Hypothesis) with timestamp generators
    - **Validates: Requirements REQ-5.2**

  - [x] 7.10 Implement slide generation
    - Create `container/sub-agent/src/slides/generator.py` — PPTX generation from summaries
    - Support 4 templates: Corporate, Modern, Elegant, Informative
    - Use `python-pptx` library for generation
    - Upload generated PPTX to S3 (`slides/{userId}/{timestamp}/`) and return download URL
    - Deliver via WhatsApp through the response queue
    - _Requirements: REQ-5.3_

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Build Docker images and ECR push pipeline
  - [x] 9.1 Create orchestrator Dockerfile
    - Create `Dockerfile.orchestrator` at repo root
    - Multi-stage build: install deps with `pnpm install --frozen-lockfile` → build TypeScript → production image with Node 20 Alpine
    - Copy compiled `dist/` and `node_modules/` (production only)
    - Set entrypoint to `node dist/index.js`
    - Include health check: `HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1`
    - _Requirements: REQ-8.3_

  - [x] 9.2 Create sub-agent Dockerfile
    - Create `container/sub-agent/Dockerfile`
    - Multi-stage: install Python deps → production image with Python 3.11 slim
    - Install system deps for OCR: tesseract-ocr, poppler-utils, libmagic
    - Run as non-root user (UID 1000), read-only rootfs compatible
    - Set entrypoint to `uvicorn src.main:app --host 0.0.0.0 --port 8000`
    - _Requirements: REQ-1.2, REQ-8.3_

  - [x] 9.3 Create GitHub Actions deployment workflow
    - Create `.github/workflows/deploy.yml` — full CI/CD pipeline
    - Stages: lint → typecheck → test → security scan (tfsec) → build Docker images → push to ECR (git-hash + latest tags) → deploy to staging → smoke test → promote to production
    - Add automatic rollback: if health check fails within 10-min window, revert to previous image tag
    - Configure AWS credentials via OIDC (GitHub Actions → IAM role)
    - Require 80% test coverage gate (vitest --coverage)
    - _Requirements: REQ-8.2, REQ-8.3_

- [x] 10. Implement health checks and monitoring integration
  - [x] 10.1 Create health check endpoints and container monitoring
    - Create `src/cloud/health/index.ts` — health check aggregator
    - Implement `/health` endpoint returning: Redis connectivity, DynamoDB reachability, OpenSearch status, container count, WhatsApp session validity
    - Implement hourly WhatsApp session health check with admin alerting on expiry
    - Implement container health monitoring: detect OOM (exit 137), repeated crashes (>3 in 5min → quarantine)
    - Emit CloudWatch custom metrics: ActiveContainers, MessagesPerMinute, ProcessingLatency, LLMLatency, VectorSearchLatency
    - _Requirements: REQ-6.1, REQ-6.3_

  - [x] 10.2 Create CloudWatch dashboard definition
    - Create `infrastructure/terraform/dashboard.tf` — CloudWatch dashboard with key metrics
    - Panels: active containers, CPU/memory, messages/min, P95 latency, error rate, DynamoDB consumed capacity, Redis memory
    - Add alarm for Docker daemon down (custom metric from health check)
    - Add alarm for WhatsApp session expiring (custom metric)
    - _Requirements: REQ-6.1_

- [x] 11. Wire end-to-end message flow
  - [x] 11.1 Integrate orchestrator with Redis queue and Data Gateway
    - Modify `src/index.ts` startup to initialize: Secrets Manager config → Data Gateway → Redis queue → rate limiter → CloudWatch logger
    - Replace SQLite session DB reads/writes with Redis queue enqueue/dequeue in `src/router.ts` and `src/delivery.ts`
    - Wire inbound flow: Baileys message → rate limit check → enqueue to Redis → sub-agent picks up
    - Wire outbound flow: sub-agent enqueues response → orchestrator dequeues → Baileys delivers to WhatsApp
    - Maintain backward compatibility: detect environment (local vs cloud) and use appropriate backend
    - _Requirements: REQ-4.1, REQ-4.2, REQ-4.3, REQ-9.1_

  - [x] 11.2 Implement PDPA compliance commands
    - Add `/export` command handler — triggers `DataGateway.exportUserData()`, uploads result to S3, sends download link via WhatsApp
    - Add `/deleteaccount` command handler — triggers `DataGateway.deleteAllUserData()`, confirms deletion via WhatsApp
    - Add consent collection flow — on first message from new user, request PDPA consent before storing data
    - Store consent flag and timestamp in user_preferences DynamoDB table
    - _Requirements: REQ-7.3_

  - [x] 11.3 Write integration tests for end-to-end message flow
    - Test: send mock WhatsApp message → verify it arrives in Redis queue → sub-agent processes → response enqueued → delivered
    - Test: document upload → processing → RAG query returns relevant chunks
    - Test: container failure → automatic restart within 30s
    - Use localstack for AWS service mocking in CI
    - _Requirements: AC-1, AC-2, AC-6_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The existing Terraform files (`infrastructure/terraform/`) are comprehensive — tasks focus on gaps (remote state, missing VPC endpoints, CI integration)
- The orchestrator remains Node.js/TypeScript; the sub-agent is a new FastAPI/Python container (as specified in the PRD)
- Environment detection (local vs cloud) preserves the ability to run NanoClaw locally during development
- `ioredis`, `@aws-sdk/*` packages are the primary new dependencies for the orchestrator
- Sub-agent Python deps are isolated in `container/sub-agent/` with its own `pyproject.toml`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4"] },
    { "id": 1, "tasks": ["2.1", "7.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "5.1", "7.2", "7.3"] },
    { "id": 3, "tasks": ["2.5", "2.6", "2.7", "4.1", "5.2", "7.4", "7.7"] },
    { "id": 4, "tasks": ["2.8", "4.2", "4.3", "5.3", "5.4", "7.5", "7.6", "7.8"] },
    { "id": 5, "tasks": ["5.5", "5.6", "7.9", "7.10"] },
    { "id": 6, "tasks": ["9.1", "9.2"] },
    { "id": 7, "tasks": ["9.3", "10.1", "10.2"] },
    { "id": 8, "tasks": ["11.1", "11.2"] },
    { "id": 9, "tasks": ["11.3"] }
  ]
}
```
