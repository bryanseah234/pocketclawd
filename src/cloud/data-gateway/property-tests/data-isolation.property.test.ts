/**
 * Property-Based Test: Data isolation enforcement (Property 1)
 *
 * Feature: nanoclaw-aws-deployment, Property 1: Data isolation enforcement
 *
 * For any two distinct userIds, queries through DataGateway as userA return
 * zero results belonging to userB. Verifies that userId filter is always
 * injected into DynamoDB, OpenSearch, and S3 queries.
 *
 * **Validates: Requirements REQ-7.1, AC-5**
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// ── Mock setup ──

// Track all DynamoDB commands sent
const dynamoCommandLog: Array<{ type: string; input: Record<string, unknown> }> = [];
// Track all S3 commands sent
const s3CommandLog: Array<{ input: Record<string, unknown> }> = [];
// Track all OpenSearch search calls
const openSearchSearchLog: Array<{ body: Record<string, unknown> }> = [];

const mockDynamoSend = vi.fn().mockImplementation(function (cmd: { _type: string; _input: Record<string, unknown> }) {
    dynamoCommandLog.push({ type: cmd._type, input: cmd._input });
    return Promise.resolve({ Items: [], LastEvaluatedKey: undefined });
});

const mockS3Send = vi.fn().mockImplementation(function (cmd: { input: Record<string, unknown> }) {
    s3CommandLog.push({ input: cmd.input });
    return Promise.resolve({ Contents: [], IsTruncated: false });
});

const mockOpenSearchSearch = vi.fn().mockImplementation(function (params: { body: Record<string, unknown> }) {
    openSearchSearchLog.push({ body: params.body });
    return Promise.resolve({ body: { hits: { hits: [] } } });
});

const mockOpenSearchIndex = vi.fn().mockResolvedValue({ body: { result: 'created' } });

vi.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: class MockDynamoDBClient {
        constructor() { }
    },
}));

vi.mock('@aws-sdk/lib-dynamodb', () => {
    class MockPutCommand {
        _input: unknown;
        _type = 'Put';
        constructor(input: unknown) { this._input = input; }
    }
    class MockQueryCommand {
        _input: unknown;
        _type = 'Query';
        constructor(input: unknown) { this._input = input; }
    }
    class MockGetCommand {
        _input: unknown;
        _type = 'Get';
        constructor(input: unknown) { this._input = input; }
    }
    class MockDeleteCommand {
        _input: unknown;
        _type = 'Delete';
        constructor(input: unknown) { this._input = input; }
    }
    return {
        DynamoDBDocumentClient: {
            from: vi.fn().mockReturnValue({ send: mockDynamoSend }),
        },
        PutCommand: MockPutCommand,
        QueryCommand: MockQueryCommand,
        GetCommand: MockGetCommand,
        DeleteCommand: MockDeleteCommand,
    };
});

vi.mock('@aws-sdk/client-s3', () => {
    class MockPutObjectCommand { input: unknown; constructor(input: unknown) { this.input = input; } }
    class MockGetObjectCommand { input: unknown; constructor(input: unknown) { this.input = input; } }
    class MockListObjectsV2Command { input: unknown; constructor(input: unknown) { this.input = input; } }
    class MockDeleteObjectCommand { input: unknown; constructor(input: unknown) { this.input = input; } }
    return {
        S3Client: class MockS3Client {
            send = mockS3Send;
            constructor() { }
        },
        PutObjectCommand: MockPutObjectCommand,
        GetObjectCommand: MockGetObjectCommand,
        ListObjectsV2Command: MockListObjectsV2Command,
        DeleteObjectCommand: MockDeleteObjectCommand,
    };
});

vi.mock('@aws-sdk/lib-storage', () => ({
    Upload: class MockUpload {
        done = vi.fn().mockResolvedValue({});
        constructor() { }
    },
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: class MockSecretsManagerClient { constructor() { } },
    GetSecretValueCommand: class MockGetSecretValueCommand { constructor() { } },
}));

vi.mock('@opensearch-project/opensearch', () => ({
    Client: class MockOpenSearchClient {
        index = mockOpenSearchIndex;
        search = mockOpenSearchSearch;
        deleteByQuery = vi.fn().mockResolvedValue({ body: { deleted: 0 } });
        bulk = vi.fn().mockResolvedValue({ body: { errors: false, items: [] } });
        indices = {
            exists: vi.fn().mockResolvedValue({ body: true }),
            create: vi.fn().mockResolvedValue({ body: { acknowledged: true } }),
            putMapping: vi.fn().mockResolvedValue({ body: { acknowledged: true } }),
        };
        constructor() { }
    },
}));

vi.mock('@opensearch-project/opensearch/aws', () => ({
    AwsSigv4Signer: vi.fn().mockReturnValue({}),
}));

vi.mock('@aws-sdk/credential-provider-node', () => ({
    defaultProvider: vi.fn().mockReturnValue(() => Promise.resolve({})),
}));

// Import after mocks
const { DataGateway } = await import('../index.js');

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

/**
 * Arbitrary for generating valid, non-empty user IDs.
 */
const arbUserId = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{2,35}$/);

/**
 * Arbitrary for generating pairs of distinct user IDs.
 */
const arbDistinctUserIds = fc.tuple(arbUserId, arbUserId).filter(([a, b]) => a !== b);

describe('Feature: nanoclaw-aws-deployment, Property 1: Data isolation enforcement', () => {
    beforeEach(() => {
        dynamoCommandLog.length = 0;
        s3CommandLog.length = 0;
        openSearchSearchLog.length = 0;
    });

    it('DynamoDB getChatHistory always includes userId = :uid condition for the querying user', async () => {
        await fc.assert(
            fc.asyncProperty(arbDistinctUserIds, async ([userA, _userB]) => {
                // Clear logs for this iteration
                const startIdx = dynamoCommandLog.length;

                const gateway = createGateway();
                const result = await gateway.getChatHistory(userA, 10);

                // Assert: userA gets zero results
                expect(result).toEqual([]);

                // Get commands logged during this iteration
                const newCommands = dynamoCommandLog.slice(startIdx);
                const queryCommands = newCommands.filter((c) => c.type === 'Query');

                // Verify at least one Query was issued
                expect(queryCommands.length).toBeGreaterThan(0);

                // Verify ALL Query commands include userA's userId filter
                for (const cmd of queryCommands) {
                    const input = cmd.input as { KeyConditionExpression: string; ExpressionAttributeValues: Record<string, string> };
                    expect(input.KeyConditionExpression).toBe('userId = :uid');
                    expect(input.ExpressionAttributeValues[':uid']).toBe(userA);
                }
            }),
            { numRuns: 100 },
        );
    });

    it('OpenSearch hybridSearch always includes { term: { userId } } filter for the querying user', async () => {
        await fc.assert(
            fc.asyncProperty(arbDistinctUserIds, async ([userA, userB]) => {
                // Clear logs for this iteration
                const startIdx = openSearchSearchLog.length;

                const gateway = createGateway();
                const results = await gateway.hybridSearch(
                    userA,
                    'test query',
                    new Array(1536).fill(0.1),
                    3,
                );

                // Assert: userA gets zero results
                expect(results).toEqual([]);

                // Get search calls logged during this iteration
                const newSearches = openSearchSearchLog.slice(startIdx);

                // hybridSearch issues 2 searches: knn + BM25
                expect(newSearches.length).toBe(2);

                // Verify BOTH search calls include userA's userId filter
                // (with the corporate-inclusive bool.should pattern from data-isolation-corporate-docs spec)
                for (const search of newSearches) {
                    const body = search.body as { query: { bool: { filter: Array<{ bool?: { should: Array<Record<string, unknown>>; minimum_should_match: number } }> } } };
                    const filters = body.query.bool.filter;

                    // The filter is now [ { bool: { should: [userA, CORPORATE], minimum_should_match: 1 } } ]
                    expect(filters).toHaveLength(1);
                    const boolShould = filters[0].bool;
                    expect(boolShould?.minimum_should_match).toBe(1);
                    expect(boolShould?.should).toContainEqual({ term: { userId: userA } });
                    expect(boolShould?.should).toContainEqual({ term: { userId: 'CORPORATE' } });

                    // Must NOT contain userB's ID anywhere in the filter
                    const filterStr = JSON.stringify(filters);
                    expect(filterStr).not.toContain(`"${userB}"`);
                }
            }),
            { numRuns: 100 },
        );
    });

    it('S3 listFiles always uses {userId}/ prefix for the querying user', async () => {
        await fc.assert(
            fc.asyncProperty(arbDistinctUserIds, async ([userA, _userB]) => {
                // Clear logs for this iteration
                const startIdx = s3CommandLog.length;

                const gateway = createGateway();
                const files = await gateway.listFiles(userA, 'documents/');

                // Assert: userA gets zero results
                expect(files).toEqual([]);

                // Get S3 commands logged during this iteration
                const newCommands = s3CommandLog.slice(startIdx);

                // Verify at least one command was issued
                expect(newCommands.length).toBeGreaterThan(0);

                // Verify the ListObjectsV2Command uses userA's prefix
                for (const cmd of newCommands) {
                    const input = cmd.input as { Prefix: string };
                    expect(input.Prefix).toBe(`${userA}/documents/`);
                    expect(input.Prefix.startsWith(`${userA}/`)).toBe(true);
                }
            }),
            { numRuns: 100 },
        );
    });

    it('S3 uploadFile enforces userId prefix — userA cannot write to userB path', async () => {
        await fc.assert(
            fc.asyncProperty(
                arbDistinctUserIds.filter(([a, b]) => !b.startsWith(a)),
                async ([userA, userB]) => {
                    const gateway = createGateway();

                    // Attempt to upload as userA but with userB's prefix
                    const stream = new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode('malicious data'));
                            controller.close();
                        },
                    });

                    // This should throw because the key doesn't start with userA's prefix
                    await expect(
                        gateway.uploadFile(userA, 'bucket', `${userB}/documents/evil.txt`, stream),
                    ).rejects.toThrow('does not start with userId prefix');
                },
            ),
            { numRuns: 100 },
        );
    });

    it('DynamoDB getChatHistoryPaginated always includes userId = :uid condition', async () => {
        await fc.assert(
            fc.asyncProperty(arbDistinctUserIds, async ([userA, _userB]) => {
                // Clear logs for this iteration
                const startIdx = dynamoCommandLog.length;

                const gateway = createGateway();
                const result = await gateway.getChatHistoryPaginated(userA, 5);

                expect(result.messages).toEqual([]);

                // Get commands logged during this iteration
                const newCommands = dynamoCommandLog.slice(startIdx);
                const queryCommands = newCommands.filter((c) => c.type === 'Query');

                // Verify at least one Query was issued
                expect(queryCommands.length).toBeGreaterThan(0);

                // Verify the QueryCommand includes userA's filter
                for (const cmd of queryCommands) {
                    const input = cmd.input as { KeyConditionExpression: string; ExpressionAttributeValues: Record<string, string> };
                    expect(input.KeyConditionExpression).toBe('userId = :uid');
                    expect(input.ExpressionAttributeValues[':uid']).toBe(userA);
                }
            }),
            { numRuns: 100 },
        );
    });
});
