<!-- AUDIT VERDICT (updated by Hermes Agent ralph loop, 2026-05-27)
Trust: MIXED. Many tasks claimed [x] by Kiro had no code.
Verified DONE (files exist + tests pass):
  - system-prompt-loader.ts + loader.test.ts
  - system-prompt-assembler.ts + assembler.test.ts + assembler.property.test.ts (bun: 36 pass)
  - container/sub-agent/src/persona/preference_probe.py
  - container/sub-agent/src/persona/escalation.py + tests/test_escalation.py
NOT IMPLEMENTED ([ ]):
  - Task 5.1: discovery_skill.py
  - Task 8: threaded reply routing wire-up
  - Task 9: session init wire-up
  - Task 10.1: system prompt template content (needs user editorial input)
-->

# Implementation Plan: Clawd Bot Persona

## Overview

Implement Clawd's persona framework for the NanoClaw WhatsApp AI assistant. The feature spans two layers: a structured system prompt template stored in AWS Secrets Manager (hot-reloadable), and application logic in the sub-agent (Python/FastAPI) and DataGateway Worker (Node.js/TypeScript) for discovery phase routing, preference persistence, escalation logging, and threaded reply mechanics. Implementation uses Python for sub-agent modules and TypeScript for DataGateway/Orchestrator components.

## Tasks

- [x] 1. Extend UserPreferences schema and DataGateway Worker
  - [x] 1.1 Extend the UserPreferences interface with persona fields
    - Add `technical_depth`, `primary_domain`, `discoveryCompleted`, and `discoveryCompletedAt` fields to the existing `UserPreferences` TypeScript interface
    - Ensure new fields are optional to maintain backward compatibility with existing user records
    - _Requirements: 1.3, 9.1_

  - [x] 1.2 Implement `put_user_preference` action handler in DataGateway Worker
    - Add a new `put_user_preference` case to the DataGateway Worker action dispatcher
    - Implement `handlePutUserPreference` that merges incoming preferences with existing stored preferences (non-destructive merge)
    - Add the corresponding `putUserPreference` method to the DataGateway service layer for DynamoDB PutItem
    - Validate `technical_depth` ∈ {"detailed", "high-level"} and `primary_domain` ∈ {"frontend", "infrastructure", "data"} before persisting
    - _Requirements: 1.3, 9.1_

  - [x] 1.3 Write property test for preference storage round-trip
    - **Property 2: Preference storage round-trip**
    - For any valid UserPreferences object, storing via `put_user_preference` and retrieving via `get_user_preference` returns identical `technical_depth`, `primary_domain`, and `discoveryCompleted` values without corrupting pre-existing fields
    - Use `fast-check` to generate arbitrary valid preference combinations
    - **Validates: Requirements 1.3, 9.1**

  - [x] 1.4 Write unit tests for `put_user_preference` handler
    - Test merge behavior preserves existing fields when only persona fields are updated
    - Test validation rejects invalid enum values
    - Test handling of missing userId returns early without error
    - _Requirements: 1.3, 9.1_

- [x] 2. Implement System Prompt Template and Hot-Reload
  - [x] 2.1 Create the System Prompt Template structure and loader
    - Create the `SystemPromptTemplate` interface with `version`, `sections` (identity, onboarding, responseStyle, guardrails, confidence, coding, escalation), and `updatedAt` fields
    - Implement the system prompt loader that fetches the template from AWS Secrets Manager (`nanoclaw/app-config` → `systemPromptTemplate` key or standalone `nanoclaw/system-prompt` secret)
    - Implement in-memory caching with TTL (default 5 minutes) and `shouldReload` check on session initialization
    - Implement fallback logic: use last cached template if Secrets Manager unavailable; use hardcoded minimal prompt if no cache exists
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 2.2 Implement system prompt assembly from template sections
    - Create the assembly function that concatenates all template sections with the existing `buildSystemPromptAddendum` runtime context
    - Ensure section ordering: identity → onboarding → responseStyle → guardrails → confidence → coding → escalation → runtime addendum
    - Handle missing/empty sections gracefully (skip without error, log warning)
    - _Requirements: 10.1, 10.3_

  - [x] 2.3 Write property test for system prompt assembly completeness
    - **Property 5: System prompt template assembly preserves all sections**
    - For any valid SystemPromptTemplate with all sections populated, the assembled output string contains content from every section with no section omitted or empty
    - Use `fast-check` to generate arbitrary section content strings
    - **Validates: Requirements 10.1, 10.3**

  - [x] 2.4 Write unit tests for system prompt loader and caching
    - Test template loads from Secrets Manager on first call
    - Test cached template is returned within TTL window
    - Test stale cache triggers reload on next session initialization
    - Test fallback to cached version when Secrets Manager is unavailable
    - Test fallback to hardcoded minimal prompt when no cache exists
    - _Requirements: 10.2, 10.4_

- [~] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement Preference Probe module in Sub-Agent
  - [x] 4.1 Create the Preference Probe module
    - Create `src/persona/preference_probe.py` in the sub-agent codebase
    - Implement `UserPersonaContext` dataclass with `is_new_user`, `technical_depth`, and `primary_domain` fields
    - Implement `probe_user_preferences(redis, user_id)` that sends a `get_user_preference` request via Redis queue to DataGateway and parses the response
    - Return `is_new_user: True` when DataGateway returns null or `discoveryCompleted` is false/absent
    - Implement fail-open behavior: return `is_new_user: True` on Redis timeout or DataGateway error
    - _Requirements: 1.1, 2.1, 9.2, 9.3, 9.4_

  - [-] 4.2 Write property test for user routing correctness
    - **Property 1: User routing correctness based on preference state**
    - For any user ID, if no stored preferences exist (or `discoveryCompleted` is false/absent), routing decision is discovery phase; if preferences exist with `discoveryCompleted` = true, routing decision is context-aware greeting
    - Use `hypothesis` to generate arbitrary preference states
    - **Validates: Requirements 1.1, 2.1, 9.3, 9.4**

  - [-] 4.3 Write unit tests for Preference Probe
    - Test returns `is_new_user: True` when DataGateway returns null
    - Test returns `is_new_user: False` with populated fields when preferences exist
    - Test fail-open returns `is_new_user: True` on Redis timeout
    - _Requirements: 1.1, 9.2, 9.3, 9.4_

- [ ] 5. Implement Discovery Phase skill
  - [-] 5.1 Create the Discovery Phase skill module
    - Create `src/persona/discovery_skill.py` in the sub-agent codebase
    - Implement the discovery flow as a skill (similar to existing `welcome` skill pattern)
    - When activated, inject discovery phase instructions into the system prompt context so Claude asks exactly two questions: technical depth preference and primary domain
    - Parse user responses and validate against allowed enum values ("detailed"/"high-level" for depth; "frontend"/"infrastructure"/"data" for domain)
    - On invalid response, re-ask the specific question
    - On valid responses, send `put_user_preference` request via Redis queue to DataGateway Worker
    - After preferences stored, acknowledge naturally and answer the user's original question in the same response
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [~] 5.2 Write unit tests for Discovery Phase skill
    - Test discovery questions are exactly two (technical depth + primary domain)
    - Test valid responses trigger preference storage
    - Test invalid enum values trigger re-ask
    - Test original question is answered after preferences are stored
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [ ] 6. Implement Escalation Logger
  - [x] 6.1 Create the Escalation Logger module
    - Create `src/persona/escalation.py` in the sub-agent codebase
    - Implement `EscalationEvent` dataclass with `user_id`, `trigger`, `context`, `session_id`, `timestamp`, and `message_ids` fields
    - Implement `log_escalation(redis, event)` that logs to DynamoDB via DataGateway (using existing `log_system_error` action with `errorType: "escalation"`) and emits a CloudWatch metric
    - Implement consecutive failure tracking: increment counter on failed resolution, reset on success, trigger escalation at 3 consecutive failures
    - Support trigger types: "consecutive_failures", "unknown_domain", "compliance_sensitive"
    - On escalation, inform user naturally, state next step, and exit session loop
    - Best-effort logging: if DynamoDB write fails, log directly to CloudWatch; never block user-facing response
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [-] 6.2 Write property test for escalation trigger logic
    - **Property 4: Escalation triggers on consecutive failures**
    - For any sequence of resolution outcomes, escalation is triggered if and only if three consecutive outcomes are failures; the event contains trigger "consecutive_failures" and references the three failed message IDs
    - Use `hypothesis` to generate arbitrary sequences of pass/fail outcomes
    - **Validates: Requirements 8.1**

  - [-] 6.3 Write unit tests for Escalation Logger
    - Test consecutive failure counter increments correctly
    - Test counter resets on successful resolution
    - Test escalation triggers at exactly 3 consecutive failures
    - Test escalation event is logged to DynamoDB and CloudWatch
    - Test graceful handling when DynamoDB write fails
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [~] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement Threaded Reply Routing
  - [~] 8.1 Implement threaded reply parsing and routing in agent-runner
    - Extend the agent-runner's poll loop to handle batched inbound messages
    - Instruct Claude (via system prompt) to delimit responses per inbound message using a structured delimiter format
    - Implement response parser that splits Claude's multi-response output and maps each segment to its source message ID via `inReplyTo`
    - Write each response segment to `messages_out` with the correct `inReplyTo` field for WhatsApp threaded replies
    - Handle edge case: single inbound message produces single response without delimiters
    - _Requirements: 3.1, 3.2_

  - [~] 8.2 Write property test for threaded reply mapping
    - **Property 3: Threaded reply maps responses to source messages**
    - For any batch of N distinct inbound messages (N ≥ 1), the system produces exactly N outbound responses, each with an `inReplyTo` matching its corresponding inbound message ID, with no duplicates and no orphans
    - Use `fast-check` to generate arbitrary message batches
    - **Validates: Requirements 3.1, 3.2**

  - [~] 8.3 Write unit tests for threaded reply routing
    - Test single message produces single response without delimiters
    - Test batch of 3 messages produces 3 threaded responses with correct `inReplyTo` mapping
    - Test malformed delimiter output falls back to single response
    - _Requirements: 3.1, 3.2_

- [ ] 9. Wire session initialization flow
  - [~] 9.1 Integrate Preference Probe into session initialization
    - Modify the agent-runner's session initialization to call `probe_user_preferences` before invoking Claude
    - Based on `UserPersonaContext.is_new_user`, inject either discovery phase context or returning-user context (with stored preferences) into the system prompt
    - For returning users, include `technical_depth` and `primary_domain` in the prompt context so Claude applies them silently
    - _Requirements: 1.1, 2.1, 2.2, 2.3, 9.2, 9.3, 9.4_

  - [~] 9.2 Integrate system prompt hot-reload into session initialization
    - Call the system prompt loader at session start; reload if cached template is stale (TTL expired)
    - Assemble final system prompt from template sections + runtime addendum + user persona context
    - _Requirements: 10.4_

  - [~] 9.3 Integrate escalation tracking into message processing loop
    - Add resolution outcome tracking (success/failure) per message in the session
    - Wire the consecutive failure counter to trigger `log_escalation` when threshold is reached
    - Wire unknown-domain and compliance-sensitive detection to trigger escalation
    - On escalation, send user-facing message and exit session loop
    - _Requirements: 7.1, 7.2, 7.3, 8.1, 8.2, 8.3, 8.4, 8.5_

  - [~] 9.4 Write integration tests for session initialization flow
    - Test new user flow: message → preference probe returns null → discovery phase activates → preferences stored → next message skips discovery
    - Test returning user flow: message → preference probe returns preferences → context-aware greeting without discovery
    - Test escalation flow: simulate 3 consecutive failures → escalation event logged → user informed
    - Test hot-reload: update template in Secrets Manager → next session uses updated prompt
    - _Requirements: 1.1, 2.1, 8.1, 10.4_

- [ ] 10. Create the system prompt template content
  - [~] 10.1 Author the system prompt template sections
    - Write the `identity` section: Clawd's name, role as senior specialist, personality baseline, conversational tone
    - Write the `onboarding` section: discovery phase instructions, two-question template, preference acknowledgment script
    - Write the `responseStyle` section: conciseness rules, numbered lists for choices, source citation format, anticipate-next-step behavior
    - Write the `guardrails` section: forbidden phrases list ("As an AI...", "Please wait while I process..."), anti-injection redirect rules, no heavy slang/excessive emoji
    - Write the `confidence` section: tier definitions (high → direct answer, partial → caveat + source + assumptions, none → no speculation + escalation trigger)
    - Write the `coding` section: fenced code blocks with language identifiers, version assumption rules, deprecation flagging
    - Write the `escalation` section: trigger conditions, natural handoff script, next-step communication
    - Store as JSON in AWS Secrets Manager under `nanoclaw/app-config` → `systemPromptTemplate` key
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 7.1, 7.2, 7.3, 10.1, 10.2, 10.3_

- [~] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Python modules (preference probe, discovery skill, escalation logger) use `hypothesis` for property-based tests
- TypeScript modules (DataGateway Worker, agent-runner, system prompt loader) use `fast-check` for property-based tests
- The system prompt template is the single source of truth for persona behavior — application code handles mechanics only
- Existing DataGateway `get_user_preference` and `log_system_error` actions are reused; only `put_user_preference` is new

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "2.2"] },
    { "id": 2, "tasks": ["1.3", "1.4", "2.3", "2.4"] },
    { "id": 3, "tasks": ["4.1", "6.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "5.1", "6.2", "6.3"] },
    { "id": 5, "tasks": ["5.2", "8.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "9.1", "9.2", "9.3"] },
    { "id": 7, "tasks": ["9.4", "10.1"] }
  ]
}
```
