/**
 * Unit tests for Data Gateway DynamoDB operations (task 2.2).
 * Mocks the DynamoDB DocumentClient to verify correct command construction,
 * TTL calculations, and userId isolation enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, UserPreferences, SystemError } from './types.js';

// Use vi.hoisted so the mock function is available when vi.mock factories run
const { mockSend } = vi.hoisted(() => ({
    mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: {
        from: vi.fn().mockReturnValue({ send: mockSend }),
    },
    PutCommand: vi.fn().mockImplementation((input) => ({ _input: input, _type: 'Put' })),
    QueryCommand: vi.fn().mockImplementation((input) => ({ _input: input, _type: 'Query' })),
    GetCommand: vi.fn().mockImplementation((input) => ({ _input: input, _type: 'Get' })),
    DeleteCommand: vi.fn().mockImplementation((input) => ({ _input: input, _type: 'Delete' })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: vi.fn().mockImplementation(() => ({})),
    PutObjectCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
    ListObjectsV2Command: vi.fn(),
    DeleteObjectCommand: vi.fn(),
}));

vi.mock('@aws-sdk/lib-storage', () => ({
    Upload: vi.fn(),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: vi.fn(),
    GetSecretValueCommand: vi.fn(),
}));

vi.mock('@opensearch-project/opensearch', () => ({
    Client: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@opensearch-project/opensearch/aws', () => ({
    AwsSigv4Signer: vi.fn().mockReturnValue({}),
}));

vi.mock('@aws-sdk/credential-provider-node', () => ({
    defaultProvider: vi.fn().mockReturnValue(() => Promise.resolve({})),
}));

// Import after mocks are set up
const { DataGateway } = await import('./index.js');
const { PutCommand, QueryCommand, GetCommand, DeleteCommand } = await import('@aws-sdk/lib-dynamodb');

function createGateway(): InstanceType<typeof DataGateway> {
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

describe('DataGateway DynamoDB operations', () => {
    let gateway: InstanceType<typeof DataGateway>;

    beforeEach(() => {
        vi.clearAllMocks();
        gateway = createGateway();
    });

    describe('userId isolation enforcement', () => {
        it('rejects empty userId on putChatMessage', async () => {
            const msg: ChatMessage = {
                messageId: 'msg-1',
                role: 'user',
                content: 'hello',
                timestamp: new Date().toISOString(),
            };
            await expect(gateway.putChatMessage('', msg)).rejects.toThrow('userId is required');
        });

        it('rejects whitespace-only userId on getChatHistory', async () => {
            await expect(gateway.getChatHistory('   ', 10)).rejects.toThrow('userId is required');
        });

        it('rejects empty userId on putUserPreference', async () => {
            const prefs: UserPreferences = {
                autoSave: true,
                notificationTime: '09:00',
                slideTemplate: 'Corporate',
                consentGiven: true,
            };
            await expect(gateway.putUserPreference('', prefs)).rejects.toThrow('userId is required');
        });

        it('rejects empty userId on createWebhookToken', async () => {
            await expect(gateway.createWebhookToken('', 'hash123')).rejects.toThrow('userId is required');
        });

        it('rejects empty userId on logSystemError', async () => {
            const error: SystemError = { errorType: 'TEST', message: 'test error' };
            await expect(gateway.logSystemError('', error)).rejects.toThrow('userId is required');
        });
    });

    describe('putChatMessage', () => {
        it('stores message with correct TTL (90 days = 7,776,000s)', async () => {
            mockSend.mockResolvedValueOnce({});

            const timestamp = '2024-06-15T10:30:00.000Z';
            const msg: ChatMessage = {
                messageId: 'msg-123',
                role: 'user',
                content: 'Hello world',
                timestamp,
            };

            await gateway.putChatMessage('user-1', msg);

            expect(PutCommand).toHaveBeenCalledWith({
                TableName: 'test-chat-messages',
                Item: {
                    userId: 'user-1',
                    timestamp,
                    messageId: 'msg-123',
                    role: 'user',
                    content: 'Hello world',
                    metadata: undefined,
                    ttl: Math.floor(new Date(timestamp).getTime() / 1000) + 7_776_000,
                },
            });
        });

        it('includes metadata when provided', async () => {
            mockSend.mockResolvedValueOnce({});

            const msg: ChatMessage = {
                messageId: 'msg-456',
                role: 'assistant',
                content: 'Response',
                timestamp: '2024-06-15T10:31:00.000Z',
                metadata: { source: 'rag', confidence: 0.95 },
            };

            await gateway.putChatMessage('user-2', msg);

            const call = vi.mocked(PutCommand).mock.calls[0][0];
            expect(call.Item.metadata).toEqual({ source: 'rag', confidence: 0.95 });
        });
    });

    describe('getChatHistory', () => {
        it('queries with userId filter and returns messages newest-first', async () => {
            mockSend.mockResolvedValueOnce({
                Items: [
                    { messageId: 'msg-2', role: 'assistant', content: 'Hi', timestamp: '2024-06-15T10:31:00Z' },
                    { messageId: 'msg-1', role: 'user', content: 'Hello', timestamp: '2024-06-15T10:30:00Z' },
                ],
            });

            const result = await gateway.getChatHistory('user-1', 10);

            expect(QueryCommand).toHaveBeenCalledWith({
                TableName: 'test-chat-messages',
                KeyConditionExpression: 'userId = :uid',
                ExpressionAttributeValues: { ':uid': 'user-1' },
                ScanIndexForward: false,
                Limit: 10,
            });

            expect(result).toHaveLength(2);
            expect(result[0].messageId).toBe('msg-2');
            expect(result[1].role).toBe('user');
        });

        it('returns empty array when no messages exist', async () => {
            mockSend.mockResolvedValueOnce({ Items: [] });

            const result = await gateway.getChatHistory('user-new', 10);
            expect(result).toEqual([]);
        });
    });

    describe('getChatHistoryPaginated', () => {
        it('passes lastEvaluatedKey for pagination', async () => {
            const lastKey = { userId: 'user-1', timestamp: '2024-06-14T00:00:00Z' };
            mockSend.mockResolvedValueOnce({
                Items: [
                    { messageId: 'msg-old', role: 'user', content: 'Old msg', timestamp: '2024-06-13T10:00:00Z' },
                ],
                LastEvaluatedKey: undefined,
            });

            const result = await gateway.getChatHistoryPaginated('user-1', 5, lastKey);

            const call = vi.mocked(QueryCommand).mock.calls[0][0];
            expect(call.ExclusiveStartKey).toEqual(lastKey);

            expect(result.messages).toHaveLength(1);
            expect(result.lastEvaluatedKey).toBeUndefined();
        });

        it('returns lastEvaluatedKey when more pages exist', async () => {
            const nextKey = { userId: 'user-1', timestamp: '2024-06-10T00:00:00Z' };
            mockSend.mockResolvedValueOnce({
                Items: [
                    { messageId: 'msg-1', role: 'user', content: 'Page 1', timestamp: '2024-06-15T10:00:00Z' },
                ],
                LastEvaluatedKey: nextKey,
            });

            const result = await gateway.getChatHistoryPaginated('user-1', 1);
            expect(result.lastEvaluatedKey).toEqual(nextKey);
        });
    });

    describe('putUserPreference', () => {
        it('stores preferences with userId as partition key', async () => {
            mockSend.mockResolvedValueOnce({});

            const prefs: UserPreferences = {
                autoSave: true,
                notificationTime: '09:00',
                slideTemplate: 'Modern',
                consentGiven: true,
                consentTimestamp: '2024-01-01T00:00:00Z',
            };

            await gateway.putUserPreference('user-1', prefs);

            expect(PutCommand).toHaveBeenCalledWith({
                TableName: 'test-user-preferences',
                Item: {
                    userId: 'user-1',
                    autoSave: true,
                    notificationTime: '09:00',
                    slideTemplate: 'Modern',
                    consentGiven: true,
                    consentTimestamp: '2024-01-01T00:00:00Z',
                },
            });
        });
    });

    describe('getUserPreference', () => {
        it('returns preferences when they exist', async () => {
            mockSend.mockResolvedValueOnce({
                Item: {
                    userId: 'user-1',
                    autoSave: false,
                    notificationTime: '08:30',
                    slideTemplate: 'Elegant',
                    consentGiven: true,
                    consentTimestamp: '2024-03-01T00:00:00Z',
                },
            });

            const result = await gateway.getUserPreference('user-1');

            expect(result).toEqual({
                autoSave: false,
                notificationTime: '08:30',
                slideTemplate: 'Elegant',
                consentGiven: true,
                consentTimestamp: '2024-03-01T00:00:00Z',
            });
        });

        it('returns null when no preferences exist', async () => {
            mockSend.mockResolvedValueOnce({ Item: undefined });

            const result = await gateway.getUserPreference('user-new');
            expect(result).toBeNull();
        });
    });

    describe('createWebhookToken', () => {
        it('stores token with 15-minute TTL (900s)', async () => {
            mockSend.mockResolvedValueOnce({});

            const beforeTime = Math.floor(Date.now() / 1000);
            await gateway.createWebhookToken('user-1', 'sha256-hash-abc');
            const afterTime = Math.floor(Date.now() / 1000);

            const call = vi.mocked(PutCommand).mock.calls[0][0];

            expect(call.TableName).toBe('test-webhook-tokens');
            expect(call.Item.tokenHash).toBe('sha256-hash-abc');
            expect(call.Item.userId).toBe('user-1');
            expect(call.Item.ttl).toBeGreaterThanOrEqual(beforeTime + 900);
            expect(call.Item.ttl).toBeLessThanOrEqual(afterTime + 900);
        });
    });

    describe('validateWebhookToken', () => {
        it('returns valid and deletes token on first use', async () => {
            const futureEpoch = Math.floor(Date.now() / 1000) + 600; // 10 min from now
            mockSend
                .mockResolvedValueOnce({
                    Item: { tokenHash: 'hash-1', userId: 'user-1', ttl: futureEpoch },
                })
                .mockResolvedValueOnce({}); // DeleteCommand succeeds

            const result = await gateway.validateWebhookToken('hash-1');

            expect(result).toEqual({ valid: true, userId: 'user-1' });

            expect(DeleteCommand).toHaveBeenCalledWith({
                TableName: 'test-webhook-tokens',
                Key: { tokenHash: 'hash-1' },
                ConditionExpression: 'attribute_exists(tokenHash)',
            });
        });

        it('returns not_found for non-existent token', async () => {
            mockSend.mockResolvedValueOnce({ Item: undefined });

            const result = await gateway.validateWebhookToken('nonexistent-hash');
            expect(result).toEqual({ valid: false, reason: 'not_found' });
        });

        it('returns expired for token past TTL', async () => {
            const pastEpoch = Math.floor(Date.now() / 1000) - 60; // 1 min ago
            mockSend.mockResolvedValueOnce({
                Item: { tokenHash: 'hash-old', userId: 'user-1', ttl: pastEpoch },
            });

            const result = await gateway.validateWebhookToken('hash-old');
            expect(result).toEqual({ valid: false, reason: 'expired' });
        });
    });

    describe('logSystemError', () => {
        it('stores error with 30-day TTL (2,592,000s)', async () => {
            mockSend.mockResolvedValueOnce({});

            const error: SystemError = {
                errorType: 'CONTAINER_OOM',
                message: 'Container killed with exit 137',
                stackTrace: 'at process.exit...',
            };

            const beforeTime = Math.floor(Date.now() / 1000);
            await gateway.logSystemError('user-1', error);
            const afterTime = Math.floor(Date.now() / 1000);

            const call = vi.mocked(PutCommand).mock.calls[0][0];

            expect(call.TableName).toBe('test-system-errors');
            expect(call.Item.userId).toBe('user-1');
            expect(call.Item.errorType).toBe('CONTAINER_OOM');
            expect(call.Item.message).toBe('Container killed with exit 137');
            expect(call.Item.stackTrace).toBe('at process.exit...');
            expect(call.Item.ttl).toBeGreaterThanOrEqual(beforeTime + 2_592_000);
            expect(call.Item.ttl).toBeLessThanOrEqual(afterTime + 2_592_000);
            expect(call.Item.timestamp).toBeDefined();
        });
    });
});
