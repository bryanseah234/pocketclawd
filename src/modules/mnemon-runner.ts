/**
 * mnemon-runner — LOCAL MODE ONLY (removed from cloud deployment).
 *
 * Mnemon (the personal knowledge graph for the single-user local install)
 * is not part of the AWS cloud deployment. In cloud mode, the knowledge
 * base is OpenSearch Serverless via DataGateway.
 *
 * This file is intentionally empty. The wiki-generator and morning-digest
 * crons that previously called mnemon now use getKnowledgeBase() which
 * resolves to the cloud OpenSearch backend when NANOCLAW_ENV=cloud.
 *
 * References:
 *   - PRD.md §1 (single-user local vision — superseded by AWS deployment)
 *   - docs/AWS-DEPLOYMENT.md (current source of truth)
 */

export {};
