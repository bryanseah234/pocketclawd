<!-- AUDIT VERDICT (updated by Hermes Agent ralph loop, 2026-05-27)
Trust: HIGH for tasks 1/3/4/7. LOW (not implemented) for tasks 6/8.
Code: 134 tests passing. TypeCheck: clean.
Task 1: DataGateway core — DONE. src/cloud/data-gateway/index.ts + corporate-isolation.test.ts (12 tests)
Task 3: DGW Worker origin validation — DONE. corporate-routing.test.ts (8 tests)
Task 4: Upload Worker corporate routing — DONE. corporate-routing.test.ts + property test (11 tests)
Task 7: Routing isolation audit — DONE. property-tests/routing-isolation.property.test.ts (7 tests)
Task 6: Admin Dashboard UI toggle — NOT IMPLEMENTED (deferred)
Task 8: Integration tests — NOT IMPLEMENTED (deferred)
-->

# Implementation Plan: Data Isolation & Corporate Documents

## Overview

This plan implements corporate document support in the NanoClaw DataGateway, enabling admin-uploaded documents to be searchable by all users via a reserved `CORPORATE` sentinel userId, while preserving strict per-user data isolation. Changes span four components: DataGateway, DataGateway Worker, Upload Worker, and Admin Dashboard.

## Tasks

- [x] 1. DataGateway core changes — CORPORATE sentinel and search filter
  - [x] 1.1 Add CORPORATE_SENTINEL constant and modify assertUserId validation
    - Add `static readonly CORPORATE_SENTINEL = 'CORPORATE'` to the DataGateway class in `src/cloud/data-gateway/index.ts`
    - Modify `assertUserId` to reject `'CORPORATE'` as a regular userId (throw error if userId equals CORPORATE_SENTINEL)
    - Ensure all existing public methods that call `assertUserId` continue to work for valid userIds
    - _Requirements: 7.3, 8.1, 1.4, 4.3_

  - [x] 1.2 Implement corporate-inclusive hybrid search filter
    - Modify `hybridSearch` in `src/cloud/data-gateway/index.ts` to use a `bool.should` filter clause matching both the user's userId and `'CORPORATE'` with `minimum_should_match: 1`
    - Apply the corporate-inclusive filter to both the kNN vector search and the BM25 keyword search
    - Ensure the filter structure matches: `{ bool: { should: [{ term: { userId: '{user_id}' } }, { term: { userId: 'CORPORATE' } }], minimum_should_match: 1 } }`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1_

  - [x] 1.3 Add indexCorporateDocument method
    - Create a new `indexCorporateDocument(chunk: DocumentChunk)` method that bypasses `assertUserId` and indexes with `userId = 'CORPORATE'`
    - This method is only callable internally (not exposed as a public DataGateway method for sub-agents)
    - _Requirements: 1.1, 7.1_

  - [x] 1.4 Modify S3 key validation to allow corporate/ prefix for reads
    - Update `assertKeyBelongsToUser` in `src/cloud/data-gateway/index.ts` to allow keys starting with `corporate/` for read operations (getFile, listFiles)
    - Maintain rejection of path traversal sequences (`../`, `..\\`) regardless of prefix
    - Ensure write operations from regular users still cannot target the `corporate/` prefix
    - _Requirements: 3.2, 3.4_

  - [x] 1.5 Modify deleteAllUserData to exclude CORPORATE documents
    - Update `deleteAllUserData` in `src/cloud/data-gateway/index.ts` to ensure the OpenSearch `deleteByQuery` filter targets only the specified userId
    - Verify the deletion does NOT include `'CORPORATE'` in the filter — only the user's own documents are deleted
    - _Requirements: 8.2_

  - [x] 1.6 Write property tests for DataGateway corporate isolation
    - Create `src/cloud/data-gateway/property-tests/corporate-isolation.property.test.ts`
    - **Property 1: userId validation rejects all invalid inputs**
    - **Property 2: Hybrid search includes corporate-inclusive filter on both sub-queries**
    - **Property 5: S3 operations reject keys outside user or corporate namespace**
    - **Property 6: CORPORATE sentinel is protected from unauthorized use**
    - **Property 7: PDPA deletion excludes CORPORATE documents**
    - **Validates: Requirements 1.4, 2.1, 2.2, 2.4, 3.1, 3.2, 3.4, 4.3, 7.1, 7.2, 7.3, 8.1, 8.2**

  - [x] 1.7 Write unit tests for DataGateway corporate search and sentinel
    - Add tests to `src/cloud/data-gateway/index.test.ts` covering:
      - Corporate documents appear in search results alongside user docs (Req 2.3)
      - assertUserId rejects empty, undefined, and CORPORATE values
      - S3 key validation allows `corporate/` reads but blocks writes from users
      - deleteAllUserData does not affect CORPORATE documents
    - _Requirements: 2.3, 7.3, 8.1, 8.2_

- [x] 2. Checkpoint — DataGateway core
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. DataGateway Worker — CORPORATE origin validation
  - [x] 3.1 Add origin validation for CORPORATE index requests
    - Modify the `index_document` handler in `src/cloud/data-gateway-worker/index.ts`
    - When `userId === 'CORPORATE'`, validate that `request.origin === 'upload_worker'`
    - If origin is not `'upload_worker'`, reject the request and log a structured security violation (type: `corporate_sentinel_abuse`)
    - When origin is valid, call `services.dataGateway.indexCorporateDocument(chunk)`
    - _Requirements: 7.1, 7.2, 3.3_

  - [x] 3.2 Add userId mismatch validation for sub-agent requests
    - In the DataGateway Worker request handler, validate that the requesting sub-agent's assigned userId matches the userId in the request
    - If mismatch detected, reject the request and log a security violation (type: `cross_user_access`)
    - _Requirements: 3.3, 8.1_

  - [x] 3.3 Write unit tests for DataGateway Worker origin validation
    - Add tests verifying:
      - CORPORATE index with `origin: 'upload_worker'` succeeds
      - CORPORATE index without valid origin is rejected
      - Sub-agent userId mismatch is rejected
      - Security violation logs are emitted correctly
    - _Requirements: 7.1, 7.2, 3.3_

- [x] 4. Upload Worker — corporate routing logic
  - [x] 4.1 Extend PendingUpload interface with corporate flag
    - Add `corporate?: boolean` field to the `PendingUpload` interface in `src/cloud/upload-worker/index.ts`
    - _Requirements: 1.1, 6.2_

  - [x] 4.2 Implement corporate upload routing in Upload Worker
    - When `corporate === true`: index chunks via DataGateway Worker with `userId = 'CORPORATE'` and `origin = 'upload_worker'`
    - When `corporate === true`: move S3 file from staging to `corporate/{uploadId}/{filename}`
    - When `corporate === false`: preserve existing behavior (dispatch to target user's sub-agent queue with specified userId)
    - When `corporate === false`: store under `{userId}/documents/{filename}` prefix
    - _Requirements: 1.1, 1.2, 1.3, 6.2_

  - [x] 4.3 Write property tests for Upload Worker corporate routing
    - Create `src/cloud/upload-worker/property-tests/corporate-upload.property.test.ts`
    - **Property 3: Corporate uploads use CORPORATE sentinel and corporate/ prefix**
    - **Property 4: Non-corporate uploads preserve the specified target userId**
    - **Validates: Requirements 1.1, 1.2, 1.3, 6.2, 6.3**

  - [x] 4.4 Write unit tests for Upload Worker corporate flow
    - Test corporate upload end-to-end: metadata parsing → S3 move → DataGateway Worker call
    - Test non-corporate upload preserves existing behavior
    - Test missing userId with corporate=false is handled gracefully
    - _Requirements: 1.1, 1.2, 1.3_

- [x] 5. Checkpoint — Backend complete
  - Ensure all tests pass, ask the user if questions arise.

- [~] 6. Admin Dashboard — corporate toggle UI
  - [~] 6.1 Add corporate toggle to upload form HTML
    - Modify `src/cloud/admin-dashboard/html.ts` to add a "Make available to all users" toggle on the document upload form
    - Default the toggle to disabled (user-specific) position
    - When toggle is disabled, display a user selection field
    - _Requirements: 6.1, 6.4_

  - [~] 6.2 Implement corporate toggle upload logic
    - Modify `src/cloud/admin-dashboard/index.ts` upload handler:
      - When toggle enabled: set `userId = 'CORPORATE'` and `s3Key = corporate/{uploadId}/{filename}` in upload metadata
      - When toggle disabled: set `userId` to selected user's identifier
      - When toggle disabled and no user selected: return 400 validation error
    - Set `corporate: true/false` flag in the Redis queue message
    - _Requirements: 6.2, 6.3, 6.5_

  - [~] 6.3 Write unit tests for Admin Dashboard corporate toggle
    - Add tests to `src/cloud/admin-dashboard/admin-dashboard.test.ts`:
      - HTML contains corporate toggle element (Req 6.1)
      - Toggle defaults to disabled (Req 6.4)
      - Toggle ON sets userId to CORPORATE (Req 6.2)
      - Toggle OFF requires user selection (Req 6.5)
      - Toggle OFF without user returns 400 (Req 6.5)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 7. Message routing validation (existing behavior confirmation)
  - [x] 7.1 Verify and document existing message routing isolation
    - Confirm the Orchestrator routes messages exclusively by sender phone number in `src/cloud/bootstrap.ts` or the relevant router module
    - Confirm unrecognized senders are not routed to any existing sub-agent
    - Confirm sub-agents only query chat history using their own assigned userId
    - Add inline comments documenting the isolation guarantees if not already present
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 7.2 Write property test for message routing isolation
    - Create `src/cloud/data-gateway/property-tests/routing-isolation.property.test.ts`
    - **Property 8: Message routing targets the correct per-user queue**
    - **Validates: Requirements 5.1**

  - [x] 7.3 Write unit tests for routing edge cases
    - Test unrecognized sender is not routed (Req 5.5)
    - Test router strips other users' content from context (Req 5.2, 5.3)
    - _Requirements: 5.2, 5.3, 5.5_

- [~] 8. Integration wiring and final validation
  - [~] 8.1 Wire all components together end-to-end
    - Ensure the Admin Dashboard → Upload Worker → DataGateway Worker → DataGateway flow works for corporate uploads
    - Ensure the Sub-Agent → DataGateway Worker → DataGateway hybrid search returns corporate + user docs
    - Verify the `origin` field is correctly propagated through the Redis queue messages
    - _Requirements: 1.1, 2.1, 7.1_

  - [~] 8.2 Write integration tests for corporate document lifecycle
    - Add to `src/cloud/integration-tests/`:
      - End-to-end corporate upload → search inclusion test
      - PDPA deletion leaves corporate docs intact
      - Sub-agent cannot index CORPORATE documents
    - _Requirements: 1.1, 2.1, 7.2, 8.2_

- [~] 9. Final checkpoint — All tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design confirms the Orchestrator/Message Router requires no code changes (Requirement 5 is already satisfied by existing isolation), but task 7.1 verifies and documents this
- All TypeScript code uses the existing project conventions (Vitest, fast-check, pnpm)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5"] },
    { "id": 2, "tasks": ["1.6", "1.7", "3.1", "3.2", "4.1"] },
    { "id": 3, "tasks": ["3.3", "4.2"] },
    { "id": 4, "tasks": ["4.3", "4.4", "6.1"] },
    { "id": 5, "tasks": ["6.2", "7.1"] },
    { "id": 6, "tasks": ["6.3", "7.2", "7.3"] },
    { "id": 7, "tasks": ["8.1"] },
    { "id": 8, "tasks": ["8.2"] }
  ]
}
```
