/**
 * session-store — stub.
 *
 * In cloud mode, session state is managed via DynamoDB (chat-messages table)
 * and Redis (in-flight queue messages). There is no SQLite session store in
 * the AWS deployment.
 *
 * The local-mode SQLite session store (inbound.db / outbound.db) is managed
 * by src/session-manager.ts which is local-mode only.
 */

export {};
