# PocketClaw — Personal AI Assistant

## Product Requirements Document v2.0

**Date:** 2026-05-24
**Status:** Draft (R0 scaffold; sections fill in via R1-R7)
**Replaces:** PRD v3.0 (now archived at `PRD.v1.archived.md`; preserved through R6, deleted at R7)
**Branch of record:** `feature/pocketclaw-build`
**Single user:** Bryan Tan

---

## 1. Product Vision

*(R1 fills this in.)*

## 2. User Stories

*(R1.)*

## 3. Goals and Non-Goals

*(R1.)*

## 4. Success Metrics

*(R1. Each metric tagged `[instrumented]` if a counter or test exists today, `[aspirational]` otherwise.)*

## 5. Competitive Analysis

*(R2.)*

## 6. System Architecture

*(R2. Includes one host/container/two-DB diagram and one capture/curation diagram.)*

## 7. Component Specifications

*(R3. One paragraph per module + path. Sourced from the §2.x inventory in `.omo/plans/pocketclaw-prd-rewrite.md`.)*

## 8. UX / Interaction Design

*(R4. Slash-commands marked `wired` / `pending kb-mcp-tool` / `pending docx-pipeline` / `pending wiki-cron`.)*

## 9. Security Architecture

*(R4.)*

## 10. Data Flow

*(R4. Two flows: inbound message → debouncer → archive → KB → recall → response. Cloud ingestion → KB → wiki/digest crons.)*

## 11. Testing Strategy

*(R5. Cites real test files; vitest baseline + bun-test for container.)*

## 12. Cross-Platform Environment

*(R5. Windows host on Scheduled Task; pnpm/Node 22; macOS/Linux notes where applicable.)*

## 13. Implementation Phases

*(R5. Honest history: re-arch P1-P7, KB MCP tool M0-M7, three follow-on plan stubs.)*

## 14. Risks and Mitigations

*(R6.)*

## 15. Non-Functional Requirements

*(R6.)*

## 16. Open Items and Future Work

*(R6. Consolidates today's stubbed/aspirational rows. Doubles as the project backlog.)*

---

## Appendix A — Glossary

*(R7.)*

## Appendix B — Environment Variable Reference

*(R7. Generated from `.env.sample` + `src/env.ts`.)*

## Appendix C — File Structure

*(R7. Generated from the live `src/` tree.)*
