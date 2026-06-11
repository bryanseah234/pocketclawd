/**
 * Unit tests for Data Gateway audit logging and PDPA compliance (task 2.5).
 * Tests logAccess, exportUserData, and deleteAllUserData methods.
 * Requirements: REQ-7.1, REQ-7.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, UserPreferences } from './types.js';

// Use vi.hoisted so the mock function is available when vi.mock factories run
const { mockDynamoSend, mockS3Send, mockOpenSearchSearch, mockOpenSearchDeleteByQuery, mockOpenSearchBulk } = vi.hoisted(() => ({
    mockDynamoSend: vi.fn(),
    mockS3Send: vi.fn(),
    mockOpenSearchSearch: vi.fn(),
    mockOpenSearchDeleteByQuery: vi.fn(),
    mockOpenSearchBulk: vi.fn(),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: class MockDynamoDBClient { constructor() { return {}; } },
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: {
        from: vi.fn().mockReturnValue({ send: mockDynamoSend }),
    },
    PutCommand: class MockPutCommand { constructor(public input: unknown) { } },
    QueryCommand: class MockQueryCommand { constructor(public input: unknown) { } },
    GetCommand: class MockGetCommand { constructor(public input: unknown) { } },
    DeleteCommand: class MockDeleteCommand { constructor(public input: unknown) { } },
}));

vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: class MockS3Client { send = mockS3Send; },
    PutObjectCommand: class MockPutObjectCommand { constructor(public input: unknown) { } },
    GetObjectCommand: class MockGetObjectCommand { constructor(public input: unknown) { } },
    ListObjectsV2Command: class MockListObjectsV2Command { constructor(public input: unknown) { } },
    DeleteObjectCommand: class MockDeleteObjectCommand { constructor(public input: unknown) { } },
}));

vi.mock('@aws-sdk/lib-storage', () => ({
    Upload: vi.fn(),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: vi.fn(),
    GetSecretValueCommand: vi.fn(),
}));

vi.mock('@opensearch-project/opensearch', () => ({
    Client: class MockOpenSearchClient {
        search = mockOpenSearchSearch;
        deleteByQuery = mockOpenSearchDeleteByQuery;
        bulk = mockOpenSearchBulk;
        indices = {
            exists: vi.fn().mockResolvedValue({ body: true }),
            create: vi.fn().mockResolvedValue({ body: { acknowledged: true } }),
            putMapping: vi.fn().mockResolvedValue({ body: { acknowledged: true } }),
        };
    },
}));

vi.mock('@opensearch-project/opensearch/aws', () => ({
    AwsSigv4Signer: vi.fn().mockReturnValue({}),
}));

vi.mock('@aws-sdk/credential-provider-node', () => ({
    defaultProvider: vi.fn().mockReturnValue(() => Promise.resolve({})),
}));

// Import after mocks are set up
const { DataGateway } = await import('./index.js');
type GatewayType = GatewayType;

function createGateway(): GatewayType {
    return DataGateway.createWithConfig({
        region: 'ap-southeast-1',
        dynamoDb: {
            chatMessagesTable: 'test-chat-messages',
            webhookTokensTable: 'test-webhook-tokens',
            userPreferencesTable: 'test-user-preferences',
            systemErrorsTable: 'test-system-errors',
        },
        openSearch: {
            endpoint: 'https://test-opensearch.example.com',
            indexName: 'documents',
        },
        s3: {
            dataBucket: 'test-data-bucket',
        },
    });
}

describe('DataGateway Audit & PDPA compliance', () => {
    let gateway: GatewayType;

    beforeEach(() => {
        vi.clearAllMocks();
        gateway = createGateway();
    });

    describe('logAccess', () => {
        it('writes structured JSON audit log entry to stdout', () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

            gateway.logAccess('user-1', 'getChatHistory', 'chat_messages');

            expect(consoleSpy).toHaveBeenCalledOnce();
            const logOutput = JSON.parse(consoleSpy.mock.calls[0][0] as string);

            expect(logOutput.userId).toBe('user-1');
            expect(logOutput.operation).toBe('getChatHistory');
            expect(logOutput.resource).toBe('chat_messages');
            expect(logOutput.success).toBe(true);
            expect(logOutput.timestamp).toBeDefined();
            // Verify timestamp is valid ISO 8601
            expect(new Date(logOutput.timestamp).toISOString()).toBe(logOutput.timestamp);

            consoleSpy.mockRestore();
        });

        it('includes all required fields: userId, operation, resource, timestamp, success', () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

            gateway.logAccess('user-abc', 'deleteFile', 's3://bucket/key');

            const logOutput = JSON.parse(consoleSpy.mock.calls[0][0] as string);
            const requiredFields = ['userId', 'operation', 'resource', 'timestamp', 'success'];
            for (const field of requiredFields) {
                expect(logOutput).toHaveProperty(field);
            }

            consoleSpy.mockRestore();
        });

        it('rejects empty userId', () => {
            expect(() => gateway.logAccess('', 'op', 'resource')).toThrow('userId is required');
        });

        it('rejects whitespace-only userId', () => {
            expect(() => gateway.logAccess('   ', 'op', 'resource')).toThrow('userId is required');
        });
    });

    describe('exportUserData', () => {
        it('gathers all user data from DynamoDB, OpenSearch, and S3', async () => {
            const chatMessages: ChatMessage[] = [
                { messageId: 'msg-1', role: 'user', content: 'Hello', timestamp: '2024-06-15T10:00:00Z' },
                { messageId: 'msg-2', role: 'assistant', content: 'Hi there', timestamp: '2024-06-15T10:01:00Z' },
            ];

            const prefs: UserPreferences = {
                autoSave: true,
                notificationTime: '09:00',
                slideTemplate: 'Corporate',
                consentGiven: true,
                consentTimestamp: '2024-01-01T00:00:00Z',
            };

            // Mock getChatHistoryPaginated (QueryCommand) — single page
            mockDynamoSend.mockResolvedValueOnce({
                Items: chatMessages.map((m) => ({ ...m, userId: 'user-1' })),
                LastEvaluatedKey: undefined,
            });

            // Mock getUserPreference (GetCommand)
            mockDynamoSend.mockResolvedValueOnce({
                Item: { userId: 'user-1', ...prefs },
            });

            // Mock OpenSearch search for documents — returns one doc
            mockOpenSearchSearch.mockResolvedValueOnce({
                body: {
                    hits: {
                        hits: [
                            {
                                _source: {
                                    id: 'doc-1',
                                    docType: 'pdf',
                                    content: 'Document content',
                                    contentVector: [0.1, 0.2],
                                    filename: 'test.pdf',
                                    pageNumber: 1,
                                    chunkIndex: 0,
                                    uploadedAt: '2024-06-10T00:00:00Z',
                                },
                            },
                        ],
                    },
                },
            });

            // Mock S3 listFiles (ListObjectsV2Command)
            mockS3Send.mockResolvedValueOnce({
                Contents: [
                    { Key: 'user-1/documents/test.pdf', Size: 1024, LastModified: new Date('2024-06-10') },
                ],
                IsTruncated: false,
            });

            const result = await gateway.exportUserData('user-1');

            expect(result.userId).toBe('user-1');
            expect(result.exportedAt).toBeDefined();
            expect(result.chatMessages).toHaveLength(2);
            expect(result.chatMessages[0].messageId).toBe('msg-1');
            expect(result.preferences).toEqual(prefs);
            expect(result.documents).toHaveLength(1);
            expect(result.documents[0].id).toBe('doc-1');
            expect(result.files).toHaveLength(1);
            expect(result.files[0].key).toBe('user-1/documents/test.pdf');
        });

        it('handles user with no data gracefully', async () => {
            // No chat messages
            mockDynamoSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
            // No preferences
            mockDynamoSend.mockResolvedValueOnce({ Item: undefined });
            // No OpenSearch documents
            mockOpenSearchSearch.mockResolvedValueOnce({ body: { hits: { hits: [] } } });
            // No S3 files
            mockS3Send.mockResolvedValueOnce({ Contents: undefined, IsTruncated: false });

            const result = await gateway.exportUserData('user-empty');

            expect(result.userId).toBe('user-empty');
            expect(result.chatMessages).toEqual([]);
            expect(result.preferences).toBeNull();
            expect(result.documents).toEqual([]);
            expect(result.files).toEqual([]);
        });

        it('paginates through all chat messages', async () => {
            const lastKey = { userId: 'user-1', timestamp: '2024-06-14T00:00:00Z' };

            // First page — returns lastEvaluatedKey
            mockDynamoSend.mockResolvedValueOnce({
                Items: [
                    { messageId: 'msg-1', role: 'user', content: 'Page 1', timestamp: '2024-06-15T10:00:00Z' },
                ],
                LastEvaluatedKey: lastKey,
            });

            // Second page — no more pages
            mockDynamoSend.mockResolvedValueOnce({
                Items: [
                    { messageId: 'msg-2', role: 'assistant', content: 'Page 2', timestamp: '2024-06-14T10:00:00Z' },
                ],
                LastEvaluatedKey: undefined,
            });

            // Preferences
            mockDynamoSend.mockResolvedValueOnce({ Item: undefined });
            // OpenSearch
            mockOpenSearchSearch.mockResolvedValueOnce({ body: { hits: { hits: [] } } });
            // S3
            mockS3Send.mockResolvedValueOnce({ Contents: undefined, IsTruncated: false });

            const result = await gateway.exportUserData('user-1');

            expect(result.chatMessages).toHaveLength(2);
            expect(result.chatMessages[0].messageId).toBe('msg-1');
            expect(result.chatMessages[1].messageId).toBe('msg-2');
        });

        it('rejects empty userId', async () => {
            await expect(gateway.exportUserData('')).rejects.toThrow('userId is required');
        });
    });

    describe('deleteAllUserData', () => {
        it('deletes all user data from DynamoDB, OpenSearch, and S3', async () => {
            // Chat messages query — returns 2 messages
            mockDynamoSend.mockResolvedValueOnce({
                Items: [
                    { messageId: 'msg-1', role: 'user', content: 'Hello', timestamp: '2024-06-15T10:00:00Z' },
                    { messageId: 'msg-2', role: 'assistant', content: 'Hi', timestamp: '2024-06-15T10:01:00Z' },
                ],
                LastEvaluatedKey: undefined,
            });

            // Delete msg-1
            mockDynamoSend.mockResolvedValueOnce({});
            // Delete msg-2
            mockDynamoSend.mockResolvedValueOnce({});

            // getUserPreference — exists
            mockDynamoSend.mockResolvedValueOnce({
                Item: {
                    userId: 'user-1',
                    autoSave: true,
                    notificationTime: '09:00',
                    slideTemplate: 'Corporate',
                    consentGiven: true,
                },
            });
            // Delete preferences
            mockDynamoSend.mockResolvedValueOnce({});

            // OpenSearch search for document count
            mockOpenSearchSearch.mockResolvedValueOnce({
                body: {
                    hits: {
                        hits: [
                            { _source: { id: 'doc-1', docType: 'pdf', content: 'x', contentVector: [], filename: 'a.pdf', pageNumber: 1, chunkIndex: 0, uploadedAt: '2024-01-01T00:00:00Z' } },
                        ],
                    },
                },
            });

            // deleteUserDocuments: search returns 1 doc, bulk deletes it
            mockOpenSearchSearch.mockResolvedValueOnce({ hits: { hits: [{ _id: 'doc-1' }] } });
            mockOpenSearchBulk.mockResolvedValueOnce({ body: { errors: false, items: [] } });

            // S3 listFiles
            mockS3Send.mockResolvedValueOnce({
                Contents: [
                    { Key: 'user-1/documents/a.pdf', Size: 512, LastModified: new Date('2024-06-10') },
                    { Key: 'user-1/slides/report.pptx', Size: 2048, LastModified: new Date('2024-06-11') },
                ],
                IsTruncated: false,
            });

            // Delete S3 file 1
            mockS3Send.mockResolvedValueOnce({});
            // Delete S3 file 2
            mockS3Send.mockResolvedValueOnce({});

            const receipt = await gateway.deleteAllUserData('user-1');

            expect(receipt.userId).toBe('user-1');
            expect(receipt.deletedAt).toBeDefined();
            expect(receipt.dynamoDbRecordsDeleted).toBe(3); // 2 messages + 1 preferences
            expect(receipt.openSearchDocumentsDeleted).toBe(1);
            expect(receipt.s3ObjectsDeleted).toBe(2);
        });

        it('handles user with no data gracefully', async () => {
            // No chat messages
            mockDynamoSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
            // No preferences
            mockDynamoSend.mockResolvedValueOnce({ Item: undefined });
            // No OpenSearch documents
            mockOpenSearchSearch.mockResolvedValueOnce({ body: { hits: { hits: [] } } });
            // deleteUserDocuments: no docs found, bulk not called
            // No S3 files
            mockS3Send.mockResolvedValueOnce({ Contents: undefined, IsTruncated: false });

            const receipt = await gateway.deleteAllUserData('user-empty');

            expect(receipt.userId).toBe('user-empty');
            expect(receipt.dynamoDbRecordsDeleted).toBe(0);
            expect(receipt.openSearchDocumentsDeleted).toBe(0);
            expect(receipt.s3ObjectsDeleted).toBe(0);
        });

        it('returns a valid DeletionReceipt with ISO timestamp', async () => {
            // No chat messages
            mockDynamoSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
            // No preferences
            mockDynamoSend.mockResolvedValueOnce({ Item: undefined });
            // No OpenSearch documents
            mockOpenSearchSearch.mockResolvedValueOnce({ body: { hits: { hits: [] } } });
            // deleteUserDocuments: no docs found, bulk not called
            // No S3 files
            mockS3Send.mockResolvedValueOnce({ Contents: undefined, IsTruncated: false });

            const receipt = await gateway.deleteAllUserData('user-1');

            // Verify deletedAt is valid ISO 8601
            expect(new Date(receipt.deletedAt).toISOString()).toBe(receipt.deletedAt);
        });

        it('rejects empty userId', async () => {
            await expect(gateway.deleteAllUserData('')).rejects.toThrow('userId is required');
        });
    });
});
