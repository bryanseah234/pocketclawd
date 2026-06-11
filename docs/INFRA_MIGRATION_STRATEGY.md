# Infrastructure Migration Strategy: Decoupling from AWS

**Author:** Gemini CLI Agent  
**Date:** June 9, 2026  
**Subject:** Strategy for transitioning NanoClaw/Clawd from AWS-centric hosting to a multi-cloud architecture.

---

## 1. Executive Summary
The current **pocketclawd** infrastructure is heavily optimized for AWS ap-southeast-1. While robust, this "single-cloud" approach carries a high "Monthly Floor" cost (~$285/mo) regardless of user activity due to provisioned serverless and compute services.

This document outlines a strategy to **decouple the architecture** into a multi-cloud model. By moving to specialized, developer-first providers (Cloudflare, Supabase, DigitalOcean/Hetzner), we can reduce fixed overhead by **~85%** while increasing vendor independence and maintaining a high-quality experience for Singapore-based professionals.

---

## 2. Component Analysis: Current vs. Proposed

The architecture is built on five functional pillars. The project's existing `IDataGateway` and `IMessageQueue` interfaces make swapping these components a configuration change rather than a code rewrite.

| Pillar | Current (AWS Stack) | Proposed (Scenario B) | Why? |
| :--- | :--- | :--- | :--- |
| **Compute** | EC2 (t3.xlarge) | Linux VPS (DO/Hetzner) | Fixed pricing vs. complex AWS billing. |
| **State** | DynamoDB | Supabase (Postgres) | SQL flexibility and easier business reporting. |
| **Search (RAG)** | OpenSearch Serverless | Supabase Vector | Eliminates the $150/mo OpenSearch "idle fee." |
| **Storage** | AWS S3 | **Cloudflare R2** | **Zero Egress Fees.** Essential for media-heavy bots. |
| **LLM / AI** | AWS Bedrock | Anthropic Direct / OpenAI | Faster access to the latest model features. |

---

## 3. Strategic Routes (The "Three Paths")

### **Route A: The "Safe" Hybrid**
*   **Infrastructure**: Keep Compute on AWS, move Storage to Cloudflare R2 and State to Supabase.
*   **Best For**: Immediate cost reduction with minimum technical risk.
*   **Maintenance**: Moderate. Still requires AWS account management.

### **Route B: The "DevOps" Powerhouse**
*   **Infrastructure**: **Hetzner Cloud** (Compute) + Supabase + Cloudflare R2.
*   **Best For**: Maximum performance-per-dollar and deep automation via Terraform.
*   **Maintenance**: High. Requires managing bare Linux OS and potential latency for SE Asia users (Hetzner lacks a SG datacenter).

### **Route C: The "SE Asia Native" (Recommended)**
*   **Infrastructure**: **DigitalOcean (SGP1 Datacenter)** + Supabase + Cloudflare R2.
*   **Best For**: Low latency for Singapore-based users with easy scaling.
*   **Maintenance**: Low. DigitalOcean's GUI and "Managed" options reduce the need for a dedicated sysadmin.

---

## 4. Comparative Matrix

| Metric | AWS (Current) | Route A (Hybrid) | Route B (Hetzner) | Route C (DO) |
| :--- | :--- | :--- | :--- | :--- |
| **Monthly Floor** | **~$285.00** | ~$130.00 | **~$35.00** | ~$45.00 |
| **SG Latency** | Ultra-Low (<10ms) | Ultra-Low (<10ms) | Moderate (200ms+) | **Low (~20ms)** |
| **Egress Costs** | High ($0.09/GB) | **Zero (via R2)** | **Zero (via R2)** | **Zero (via R2)** |
| **Setup Effort** | N/A (Live) | 1-2 Days | 3-5 Days | 2-3 Days |

---

## 5. Risk Assessment & Mitigation

Moving away from a single vendor introduces "Distributed Risk." Below is the assessment of these risks:

| Risk | Impact | Mitigation Strategy |
| :--- | :--- | :--- |
| **Third-Party Outage** (e.g. Supabase) | Bot loses memory/prefs. | Implement a daily local SQLite backup of core tables. |
| **Network Latency** | Bot feels "laggy" to users. | Prioritize Route C (DigitalOcean Singapore) or use Global CDNs. |
| **Security Fragmentation** | Secrets in multiple places. | Centralize all multi-cloud keys in the existing **OneCLI Vault**. |
| **API Rate Limits** | Interrupted service. | Use the project's built-in `CircuitBreaker` and Rate Limiter modules. |

---

## 6. Technical Feasibility
The migration is technically "Medium" difficulty because the **NanoClaw v2** architecture was built for vendor neutrality:

1.  **Data Isolation**: The `DataGateway` class (found in `src/cloud/data-gateway/`) already encapsulates all DB logic. We only need to write a `SupabaseDataGateway` implementation.
2.  **S3 Compatibility**: Cloudflare R2 supports the standard S3 API. No changes to the `uploadFile` or `getFile` logic are required—only a change to the `endpoint` configuration.
3.  **OneCLI Integration**: The system already has a secret injection layer. Adding new providers simply means adding the new API keys to the vault.

---

## 7. Next Steps
1.  **Phase 1 (Validation)**: Deploy a parallel test instance on DigitalOcean using a trial Supabase account.
2.  **Phase 2 (Migration)**: Sync current S3 media to Cloudflare R2 (idempotent operation).
3.  **Phase 3 (Cutover)**: Point the WhatsApp/Telegram Webhooks to the new IP address.
