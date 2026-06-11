# Requirements: NanoClaw AWS Deployment

## Overview

Deploy NanoClaw WhatsApp Assistant as a cloud-native system on AWS infrastructure, converting the Azure-targeted PRD to equivalent AWS services. The system provides AI-powered WhatsApp assistance with document processing, RAG-based knowledge retrieval, and automated notifications.

## Requirements

### REQ-1: Core Infrastructure

#### REQ-1.1: Compute

- MUST deploy on an AWS EC2 instance (r6i.4xlarge — 16 vCPU, 128 GB RAM equivalent to Azure E16s_v3)
- MUST run rootless Docker with socket proxy for sub-agent container isolation
- MUST configure security groups: inbound 443 (admin UI), 22 (admin IPs only), deny all other inbound
- MUST deploy within a VPC with dedicated subnet

#### REQ-1.2: Container Isolation

- MUST enforce per-user Docker containers with 512 MB memory limit, 50% single-core CPU quota, 100 PID limit, 2 GB disk quota
- MUST run containers as non-root (UID 1000), read-only rootfs, all capabilities dropped, seccomp filtering
- MUST provide per-container network namespaces with management network (172.20.0.0/16) and per-user subnets
- MUST allow outbound-only access to AWS services from containers

#### REQ-1.3: Secrets Management

- MUST use AWS Secrets Manager for all credentials (DB connection strings, API keys, search keys, LLM keys, Redis connection)
- MUST implement 90-day automatic rotation for all secrets
- MUST inject secrets at runtime via IAM roles, never in env vars or source code

### REQ-2: Data Storage

#### REQ-2.1: Document Database

- MUST use Amazon DynamoDB as the primary document store (replacing Cosmos DB)
- MUST create tables: chat_messages (partition key: userId, sort key: timestamp), webhook_tokens (partition key: tokenHash), user_preferences (partition key: userId), system_errors (partition key: userId, sort key: timestamp)
- MUST configure TTL: chat_messages 90 days, webhook_tokens 15 minutes, system_errors 30 days
- MUST provision on-demand capacity mode for cost efficiency at current scale

#### REQ-2.2: Vector Search

- MUST use Amazon OpenSearch Serverless with vector search capability (replacing Azure AI Search)
- MUST create a "documents" index with fields: id, userId, docType, content, contentVector (1536 dimensions), filename, pageNumber, chunkIndex, uploadedAt
- MUST enforce userId filter on all queries for data isolation
- MUST support hybrid search (vector similarity + BM25 keyword matching)

#### REQ-2.3: Object Storage

- MUST use Amazon S3 for all file storage (replacing Azure Blob Storage)
- MUST create buckets/prefixes: staging/ (pending malware scan), documents/ (processed files), corporate/ (shared docs), sessions/ (Baileys auth persistence)
- MUST stream uploads directly to S3, bypassing local VM storage
- MUST enable versioning and server-side encryption (SSE-S3)

### REQ-3: AI and RAG Pipeline

#### REQ-3.1: LLM Integration

- MUST use Amazon Bedrock with Claude 3.5 Sonnet (or latest available) as the primary LLM
- MUST support task-specific temperature configuration: chat 0.5, summarization 0.3, slide generation 0.8, RAG QA 0.2
- MUST enforce max output of 4096 tokens per response
- MUST implement circuit breaker pattern for LLM API failures

#### REQ-3.2: Embedding Pipeline

- MUST use Amazon Bedrock Titan Embeddings (or Cohere Embed) for vector generation
- MUST produce 1536-dimension vectors
- MUST chunk documents at 512 tokens with 50-token overlap using recursive character splitter
- MUST batch embed 50 chunks per API call with exponential backoff retry (up to 5 retries)

#### REQ-3.3: RAG Retrieval

- MUST implement hybrid retrieval: 70% vector similarity (cosine, threshold 0.7) + 30% BM25 keyword
- MUST apply cross-encoder reranking on combined results
- MUST return top 3 chunks after reranking as LLM context
- MUST include source attribution (filename, page number, relevance score) in context formatting
- MUST maintain 30-message conversation history (up to 3000 tokens) for long-term memory

### REQ-4: Messaging and Orchestration

#### REQ-4.1: WhatsApp Integration

- MUST use Baileys (Node.js) for WhatsApp protocol handling
- MUST persist WhatsApp sessions to S3 for recovery across restarts
- MUST implement rate limiting: 20 messages/min per user, 200 messages/hour total
- MUST implement QR-based admin authentication flow

#### REQ-4.2: Message Queue

- MUST use Amazon ElastiCache for Redis as the message queue between orchestrator and sub-agents
- MUST support asynchronous message processing with backpressure handling
- MUST implement dead letter queue for failed processing (retry up to 3 times every 6 hours)

#### REQ-4.3: Orchestrator

- MUST run as a systemd service with automatic restart on failure
- MUST manage sub-agent container lifecycle (spawn, monitor, terminate based on activity)
- MUST route messages from WhatsApp handler → container manager → appropriate sub-agent
- MUST implement scheduler service for daily notifications (9:00 AM SGT)

### REQ-5: Sub-Agent Application

#### REQ-5.1: Sub-Agent Runtime

- MUST run as a FastAPI application inside each user's Docker container
- MUST handle: message processing, vector store queries, LLM communication, document ingestion
- MUST implement document processing pipeline: upload → malware scan → text extraction → chunking → embedding → indexing
- MUST support file types: PDF (text + OCR), DOCX, CSV, TXT, images (with OCR)

#### REQ-5.2: Document Management

- MUST implement webhook-based save confirmation with SHA-256 hashed one-time tokens (15-min expiry)
- MUST support auto-save mode (configurable per user)
- MUST implement commands: /list (show indexed docs), /delete [filename], /update (re-process doc)

#### REQ-5.3: Slide Generation

- MUST generate PowerPoint presentations from document summaries using pptxgenjs or python-pptx
- MUST support 4 templates: Corporate, Modern, Elegant, Informative
- MUST deliver generated PPTX via WhatsApp after uploading to S3

### REQ-6: Monitoring and Operations

#### REQ-6.1: Monitoring

- MUST use Amazon CloudWatch for metrics collection and alerting
- MUST track: active containers, memory/CPU per container, messages/min, processing latency, LLM latency, vector search latency
- MUST configure alerts: high error rate (>10 in 5min), container OOM (exit 137), DynamoDB throttling, Docker daemon down, high latency (>60s), session expiring

#### REQ-6.2: Logging

- MUST write logs to CloudWatch Logs with structured JSON format
- MUST implement log levels: INFO (30-day retention), WARNING (60-day), ERROR (90-day)
- MUST redact sensitive data (passwords, tokens, API keys, message content) before logging
- MUST archive logs to S3 for long-term retention

#### REQ-6.3: Health Checks

- MUST implement hourly WhatsApp session health check with admin alerting on expiry
- MUST implement container health monitoring with automatic restart on failure
- MUST provide admin dashboard endpoint showing system health overview

### REQ-7: Security and Compliance

#### REQ-7.1: Data Isolation

- MUST enforce complete data isolation between users at all layers (DynamoDB, OpenSearch, S3, containers)
- MUST achieve zero cross-user data leakage (verified by security testing)
- MUST implement mandatory userId filter on all database and search queries

#### REQ-7.2: Network Security

- MUST deploy within VPC with private subnets for compute, public subnet only for NAT gateway
- MUST use security groups and NACLs for defense in depth
- MUST encrypt all data in transit (TLS 1.2+) and at rest (AES-256)

#### REQ-7.3: PDPA Compliance

- MUST implement user consent collection before storing personal data
- MUST support data export (/export command) within 24 hours
- MUST support complete data deletion (/deleteaccount) within 30 days
- MUST maintain audit logs for 1 year
- MUST store all data in ap-southeast-1 (Singapore) region

### REQ-8: Deployment and CI/CD

#### REQ-8.1: Infrastructure as Code

- MUST define all AWS resources using Terraform
- MUST support repeatable deployments across environments (staging, production)
- MUST version-control all infrastructure definitions

#### REQ-8.2: CI/CD Pipeline

- MUST implement GitHub Actions pipeline: lint → test → security scan → build → deploy staging → smoke test → promote to production
- MUST require 80% unit test coverage
- MUST push container images to Amazon ECR with git-hash tags
- MUST implement automatic rollback on health check failure (10-min monitoring window)

#### REQ-8.3: Container Registry

- MUST use Amazon ECR for container image storage
- MUST tag images with git commit hash and "latest"
- MUST store two images: nanoclaw/orchestrator and nanoclaw/agent

### REQ-9: Performance

#### REQ-9.1: Latency

- MUST achieve P95 response latency ≤ 30 seconds
- MUST achieve document text extraction accuracy ≥ 98%
- MUST achieve OCR accuracy ≥ 80% for scanned PDFs

#### REQ-9.2: Capacity

- MUST support ≥ 50 concurrent users
- MUST achieve 99.5% monthly uptime (≤ 3.6h downtime/month)

#### REQ-9.3: Scaling

- MUST support vertical scaling path (r6i.4xlarge → r6i.8xlarge)
- SHOULD support horizontal scaling with sticky sessions for WhatsApp session affinity
- SHOULD document migration path to WhatsApp Cloud API for stateless scaling

## Acceptance Criteria

- AC-1: End-to-end message flow works: send WhatsApp message → receive AI response within 30 seconds
- AC-2: Document upload, processing, and RAG query returns correct results
- AC-3: Daily notification generated and delivered at scheduled time
- AC-4: Slide generation produces valid PPTX delivered via WhatsApp
- AC-5: Zero cross-user data leakage under concurrent load testing (50 users)
- AC-6: System recovers automatically from container failures and service restarts
- AC-7: All infrastructure deployable via `terraform apply` from clean state
- AC-8: CI/CD pipeline deploys to staging and production with rollback capability
