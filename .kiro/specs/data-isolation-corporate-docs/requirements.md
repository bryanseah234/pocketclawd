# Requirements Document

## Introduction

This feature establishes data isolation boundaries in the NanoClaw cloud WhatsApp AI assistant, ensuring that each user's documents, chat history, and preferences remain private while enabling admin-uploaded corporate documents to be searchable by all users. The system uses a shared WhatsApp admin account (via Baileys) that receives messages from multiple users, making message routing isolation critical.

## Glossary

- **DataGateway**: The persistence layer (`src/cloud/data-gateway/index.ts`) that enforces userId-based isolation on all DynamoDB, OpenSearch, and S3 operations.
- **Sub_Agent**: A per-user container process that handles AI interactions for a single user; communicates with the DataGateway via Redis message queues.
- **Orchestrator**: The central process that routes incoming WhatsApp messages to the correct Sub_Agent and manages the upload worker.
- **Corporate_Document**: A document uploaded by an admin and marked for access by all users, stored with `userId = 'CORPORATE'` in OpenSearch and under the `corporate/` prefix in S3.
- **User_Document**: A document uploaded by or assigned to a specific user, stored with that user's `userId` in OpenSearch and under the user's prefix in S3.
- **Hybrid_Search**: The OpenSearch query combining vector (kNN) similarity and BM25 keyword matching, filtered by userId.
- **Admin_Dashboard**: The web interface used by administrators to upload documents and manage the system.
- **Baileys_Adapter**: The WhatsApp Web protocol adapter that connects to a single admin WhatsApp account and receives direct messages from multiple end users.
- **CORPORATE_Sentinel**: The reserved userId value `'CORPORATE'` used to tag documents accessible to all users.

## Requirements

### Requirement 1: Corporate Document Indexing

**User Story:** As an admin, I want to upload documents that are searchable by all users, so that shared knowledge is available system-wide without duplicating files per user.

#### Acceptance Criteria

1. WHEN an admin uploads a document with the corporate flag enabled, THE Upload_Worker SHALL index all chunks with `userId = 'CORPORATE'` in OpenSearch.
2. WHEN an admin uploads a document with the corporate flag enabled, THE Upload_Worker SHALL store the file in S3 under the `corporate/` prefix.
3. WHEN an admin uploads a document without the corporate flag, THE Upload_Worker SHALL index chunks with the specified target user's userId.
4. THE DataGateway SHALL reject any attempt to index a document where userId is empty or undefined.

### Requirement 2: Corporate Document Search Inclusion

**User Story:** As a user, I want my RAG searches to include corporate documents alongside my personal documents, so that I benefit from shared organizational knowledge.

#### Acceptance Criteria

1. WHEN a user performs a hybrid search, THE DataGateway SHALL query OpenSearch with a filter matching documents where `userId` equals the requesting user's ID OR `userId` equals `'CORPORATE'`.
2. THE DataGateway SHALL use the OpenSearch bool query: `{ bool: { should: [{ term: { userId: '{user_id}' } }, { term: { userId: 'CORPORATE' } }], minimum_should_match: 1 } }` as the filter clause.
3. WHEN corporate documents match a search query, THE DataGateway SHALL return them in the results alongside the user's personal documents, ranked by relevance score.
4. THE DataGateway SHALL apply the corporate-inclusive filter to both the vector (kNN) search and the BM25 keyword search.

### Requirement 3: User Document Privacy

**User Story:** As a user, I want my uploaded documents to be accessible only to me, so that my private information is not exposed to other users.

#### Acceptance Criteria

1. THE DataGateway SHALL enforce a userId filter on every OpenSearch query, ensuring a user can only retrieve documents tagged with their own userId or the CORPORATE_Sentinel.
2. THE DataGateway SHALL store user-uploaded documents in S3 under a path prefixed with the user's userId.
3. IF a Sub_Agent sends a request with a userId that does not match the Sub_Agent's assigned userId, THEN THE DataGateway_Worker SHALL reject the request and log a security violation.
4. THE DataGateway SHALL prevent any operation from listing or accessing S3 objects outside the requesting user's prefix or the `corporate/` prefix.

### Requirement 4: Chat History Isolation

**User Story:** As a user, I want my chat history to be private and inaccessible to other users, so that my conversations remain confidential.

#### Acceptance Criteria

1. THE DataGateway SHALL use the userId as the DynamoDB partition key for all chat message operations, ensuring queries only return messages belonging to the requesting user.
2. WHEN a Sub_Agent requests chat history, THE DataGateway_Worker SHALL only return messages where the partition key matches the requesting Sub_Agent's assigned userId.
3. THE DataGateway SHALL reject chat history requests where the userId parameter is empty, undefined, or does not match the authenticated context.

### Requirement 5: WhatsApp Message Routing Isolation

**User Story:** As a user, I want my WhatsApp messages to be routed only to my Sub_Agent, so that other users cannot see my conversations.

#### Acceptance Criteria

1. WHEN the Baileys_Adapter receives an incoming message, THE Orchestrator SHALL route the message exclusively to the Sub_Agent assigned to the sender's phone number.
2. THE Orchestrator SHALL strip all message content from other users before passing context to any Sub_Agent.
3. WHEN routing a message to a Sub_Agent, THE Orchestrator SHALL include only the conversation thread between the system and the specific user identified by their phone number.
4. THE Sub_Agent SHALL only query chat history from DynamoDB using its own assigned userId as the partition key.
5. IF the Orchestrator receives a message from an unrecognized sender, THEN THE Orchestrator SHALL not route the message to any existing Sub_Agent and SHALL log the event.

### Requirement 6: Admin Dashboard Upload Controls

**User Story:** As an admin, I want a toggle in the upload interface to choose between corporate and user-specific document uploads, so that I can control document visibility.

#### Acceptance Criteria

1. THE Admin_Dashboard SHALL display a toggle labeled "Make available to all users" on the document upload form.
2. WHEN the toggle is enabled, THE Admin_Dashboard SHALL set the upload metadata field `userId` to `'CORPORATE'` and the S3 key prefix to `corporate/`.
3. WHEN the toggle is disabled, THE Admin_Dashboard SHALL display a user selection field and set the upload metadata `userId` to the selected user's identifier.
4. THE Admin_Dashboard SHALL default the toggle to the disabled (user-specific) position to prevent accidental corporate-wide exposure.
5. IF an admin submits an upload with the toggle disabled and no user selected, THEN THE Admin_Dashboard SHALL display a validation error and prevent submission.

### Requirement 7: CORPORATE Sentinel Protection

**User Story:** As a system operator, I want the CORPORATE userId sentinel to be protected from misuse, so that regular users cannot impersonate corporate document ownership.

#### Acceptance Criteria

1. THE DataGateway SHALL reject any document indexing request where the userId is `'CORPORATE'` unless the request originates from the Upload_Worker processing an admin-flagged upload.
2. IF a Sub_Agent sends a request to index a document with `userId = 'CORPORATE'`, THEN THE DataGateway_Worker SHALL reject the request and log a security violation.
3. THE DataGateway SHALL treat `'CORPORATE'` as a reserved userId that cannot be assigned to any real user account.

### Requirement 8: Cross-User Data Leak Prevention

**User Story:** As a system operator, I want guarantees that no data leaks occur between users, so that the system maintains trust and compliance.

#### Acceptance Criteria

1. THE DataGateway SHALL validate the userId parameter on every public method invocation and reject requests with missing or empty userId values.
2. WHEN the DataGateway deletes user data (PDPA compliance), THE DataGateway SHALL only delete documents, chat messages, and files belonging to the specified userId and SHALL NOT affect CORPORATE documents.
3. THE Sub_Agent SHALL not have direct network access to DynamoDB, OpenSearch, or S3; all persistence operations SHALL pass through the DataGateway_Worker via Redis queues.
4. THE Orchestrator SHALL assign each Sub_Agent a fixed userId at container startup that cannot be changed during the Sub_Agent's lifetime.
