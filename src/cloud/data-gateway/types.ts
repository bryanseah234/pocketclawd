/**
 * Data Gateway types — interfaces for all persistence operations.
 * Every public method accepts userId as the first parameter to enforce
 * data isolation at the gateway level.
 */

// ── DynamoDB entities ──

export interface ChatMessage {
    messageId: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string; // ISO 8601
    metadata?: Record<string, unknown>;
}

export interface UserPreferences {
    autoSave: boolean;
    notificationTime: string; // HH:MM
    slideTemplate: 'Corporate' | 'Modern' | 'Elegant' | 'Informative';
    consentGiven: boolean;
    consentTimestamp?: string; // ISO 8601

    // Persona fields (discovery phase preferences)
    technical_depth?: 'detailed' | 'high-level';
    primary_domain?: 'frontend' | 'infrastructure' | 'data';
    discoveryCompleted?: boolean;
    discoveryCompletedAt?: string; // ISO 8601
}

export interface TokenValidation {
    valid: boolean;
    userId?: string;
    reason?: 'expired' | 'already_used' | 'not_found';
}

export interface SystemError {
    errorType: string;
    message: string;
    stackTrace?: string;
}

export interface PaginatedChatHistory {
    messages: ChatMessage[];
    lastEvaluatedKey?: Record<string, unknown>;
}

// ── OpenSearch entities ──

export interface DocumentChunk {
    id: string;
    docType: string;
    content: string;
    contentVector: number[]; // 1536 dimensions
    filename: string;
    pageNumber: number;
    chunkIndex: number;
    uploadedAt: string; // ISO 8601
}

export interface SearchResult {
    id: string;
    content: string;
    filename: string;
    pageNumber: number;
    chunkIndex: number;
    score: number;
    source: 'vector' | 'keyword' | 'hybrid';
}

// ── S3 entities ──

export interface FileMetadata {
    key: string;
    size: number;
    lastModified: string; // ISO 8601
    contentType?: string;
}

// ── Audit & PDPA ──

export interface AuditLogEntry {
    userId: string;
    operation: string;
    resource: string;
    timestamp: string; // ISO 8601
    success: boolean;
}

export interface UserDataExport {
    userId: string;
    exportedAt: string;
    chatMessages: ChatMessage[];
    preferences: UserPreferences | null;
    documents: DocumentChunk[];
    files: FileMetadata[];
}

export interface DeletionReceipt {
    userId: string;
    deletedAt: string;
    dynamoDbRecordsDeleted: number;
    openSearchDocumentsDeleted: number;
    s3ObjectsDeleted: number;
}

// ── Configuration ──

export interface DataGatewayConfig {
    region: string;
    dynamoDb: {
        chatMessagesTable: string;
        webhookTokensTable: string;
        userPreferencesTable: string;
        systemErrorsTable: string;
    };
    openSearch: {
        endpoint: string;
        indexName: string;
    };
    s3: {
        dataBucket: string;
    };
}

// ── Data Gateway interface ──

export interface IDataGateway {
    // Index management
    ensureIndex(): Promise<void>;

    // DynamoDB operations
    putChatMessage(userId: string, message: ChatMessage): Promise<void>;
    getChatHistory(userId: string, limit: number): Promise<ChatMessage[]>;
    getChatHistoryPaginated(userId: string, limit: number, lastEvaluatedKey?: Record<string, unknown>): Promise<PaginatedChatHistory>;
    putUserPreference(userId: string, prefs: UserPreferences): Promise<void>;
    getUserPreference(userId: string): Promise<UserPreferences | null>;
    createWebhookToken(userId: string, tokenHash: string): Promise<void>;
    validateWebhookToken(tokenHash: string): Promise<TokenValidation>;
    logSystemError(userId: string, error: SystemError): Promise<void>;

    // OpenSearch operations
    indexDocument(userId: string, chunk: DocumentChunk): Promise<void>;
    /**
     * Index a document chunk with the CORPORATE sentinel userId.
     * Reserved for the Upload Worker only — sub-agents must not call this directly.
     * Requirements: 1.1, 7.1
     */
    indexCorporateDocument(chunk: DocumentChunk): Promise<void>;
    hybridSearch(userId: string, query: string, vector: number[], topK: number): Promise<SearchResult[]>;
    deleteUserDocuments(userId: string, filename?: string): Promise<void>;

    // S3 operations
    uploadFile(userId: string, bucket: string, key: string, stream: ReadableStream): Promise<string>;
    getFile(userId: string, bucket: string, key: string): Promise<ReadableStream>;
    listFiles(userId: string, prefix: string): Promise<FileMetadata[]>;
    deleteFile(userId: string, bucket: string, key: string): Promise<void>;

    // Audit
    logAccess(userId: string, operation: string, resource: string): void;

    // PDPA compliance
    exportUserData(userId: string): Promise<UserDataExport>;
    deleteAllUserData(userId: string): Promise<DeletionReceipt>;
}
