PRD vs CURRENT REPO STATE — GAP ANALYSIS
=========================================
Date: 2026-05-27
Branch: feature/nanoclaw-aws-deployment (HEAD c90ff8b)
Live: http://3.0.132.150:3000  (health=200, admin=200 with Basic auth)

NOTE: PRD was written as an Azure blueprint. Repo targets AWS instead.
      The infra swap is intentional — this analysis treats the FEATURES
      as goals regardless of cloud provider.

PRD is structured in 3 phases: A (Core), B (Personalisation/Advanced), C (Hardening).


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE A — CORE SYSTEM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[DONE] EC2 running, port 3000 live, container healthy 21h
[DONE] NanoClaw orchestrator as Docker container (not systemd, but --restart unless-stopped = same result)
[DONE] Sub-agent containers (FastAPI) with per-user isolation
[DONE] Baileys WhatsApp integration in orchestrator
[DONE] Admin QR code interface (src/cloud/admin-dashboard/ + html.ts)
[DONE] DynamoDB tables (4: chat-messages, user-preferences, system-errors, webhook-tokens)
[DONE] OpenSearch Serverless collection for vector search
[DONE] ElastiCache Redis for message queue
[DONE] Bedrock LLM (Claude Opus 4 orchestrator, Sonnet 4 sub-agent)
[DONE] Bedrock embeddings (Titan v2)
[DONE] S3 document storage
[DONE] Secrets Manager config
[DONE] RAG pipeline (hybrid search in data-gateway with bool.should filter)
[DONE] Data isolation per user (corporate-docs spec fully implemented)
[DONE] Document upload pipeline (admin dashboard → S3 → data-gateway-worker → OpenSearch)
[DONE] Corporate document flag + CORPORATE sentinel isolation
[PARTIAL] Basic monitoring — CloudWatch exists but no custom dashboards/alert rules yet
[PARTIAL] Systemd service — container uses --restart flag, not a proper systemd unit on host
[MISSING] Load test: 5 concurrent users, P95 ≤30s (no k6 tests exist)
[MISSING] Security scan with zero critical findings (tfsec runs in CI but findings not reviewed)
[MISSING] WhatsApp session persistence to S3/DynamoDB (sessions stored at /opt/nanoclaw-data/store, not backed to S3)


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE B — PERSONALISATION & ADVANCED FEATURES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[DONE] User preference management infrastructure (DynamoDB nanoclaw-user-preferences)
[DONE] Discovery flow (discovery_skill.py — 2 questions: depth + domain preference)
[DONE] System prompt template authored + pushed to Secrets Manager
[DONE] Session init wire-up (session-init.ts — probes prefs, builds addendum)
[PARTIAL] Daily notification job — cron at 07:00 exists in scheduler.ts but logs "SKIP | no-handler" (handler not wired to sub-agent delivery)
[PARTIAL] Conversation history — DynamoDB chat-messages table exists; retrieval logic in sub-agent not confirmed wired to last-30-messages fetch
[MISSING] Daily notification content generation (LLM briefing based on user prefs)
[MISSING] Daily notification delivery via WhatsApp (handler not implemented)
[MISSING] PowerPoint / slide generation (spec says 4 templates; zero code exists for this)
[MISSING] /list, /delete document management commands in sub-agent
[MISSING] Admin CLI tool for corporate document ingestion (terminal-based, not the dashboard upload)
[MISSING] Message rate limiting enforcement (20/min per user, 200/hr global — defined in PRD but no rate-limiter code found)
[MISSING] Threaded reply routing wired into the agent poll loop (threaded-reply-parser.ts written but not integrated)


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE C — HARDENING & COMPLIANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[DONE] PDPA delete pathway (deleteAllUserData in data-gateway, confirmed safe for CORPORATE docs)
[DONE] /export data subject access request logic exists (data-gateway exportUserData)
[DONE] Property-based tests + integration tests for data isolation
[DONE] Typecheck CI gate
[PARTIAL] 80% test coverage target — vitest suite is strong (493 tests) but no coverage % measured
[MISSING] Load test 50 concurrent users P95 ≤30s
[MISSING] Penetration test / security assessment report
[MISSING] Disaster recovery runbook and tested recovery procedure
[MISSING] CloudWatch custom dashboards with alert rules (high error rate, OOM, high latency)
[MISSING] WhatsApp session expiry alerts (7-day pre-warning to admin)
[MISSING] PDPA consent collection on first WhatsApp contact
[MISSING] /privacy command (withdraw consent)
[MISSING] Annual consent renewal reminder


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CI/CD (PRD Section 10)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[DONE] GitHub Actions CI (lint, typecheck, test, terraform-validate) on push
[DONE] deploy.yml exists for main/staging → ECR → SSM deploy with rollback
[JUST ADDED] deploy-feature.yml — fires on feature/nanoclaw-aws-deployment push,
             typecheck+test → ECR build → SSM deploy → health check. Running NOW.
             Pipeline: https://github.com/tokenlab42/clawd/actions/runs/26496606290
[MISSING] Coverage threshold check in CI (deploy.yml has it but it checks main only)
[MISSING] k6 smoke tests in CI pipeline
[MISSING] tfsec findings not all passing (soft_fail=false but previous runs showed failures)


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUMMARY SCORECARD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase A (Core):            ~80% done  (main gap: load test, WA session persistence, CloudWatch alerts)
Phase B (Advanced):        ~45% done  (main gap: daily briefings, slide gen, /list /delete, rate limiting)
Phase C (Hardening):       ~35% done  (main gap: load test, pentest, DR runbook, PDPA consent flow)
CD pipeline:               ~90% done  (just wired feature-branch auto-deploy; main gap: k6 smoke tests)

Overall vs PRD:  ~60% of full PRD scope is built or in progress.
The system is FUNCTIONAL as a WhatsApp AI assistant with RAG and data isolation.
The missing 40% is mostly Phase B features (notifications, slides) and Phase C hardening.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO TEST RIGHT NOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Admin dashboard:   http://3.0.132.150:3000/admin
Auth:              Basic auth — username: admin  password: NcLaw$2026!xK9m
Health endpoint:   http://3.0.132.150:3000/health  (no auth, returns {"status":"ok"})

From a browser, just visit the URL and enter the credentials when prompted.
The dashboard shows: WhatsApp QR/status, container health, message stats, upload panel.