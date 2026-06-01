/**


 * Property-Based Test: PDPA data lifecycle (Property 8)


 *


 * Feature: nanoclaw-aws-deployment, Property 8: PDPA data lifecycle


 *


 * For any user with data stored across all persistence layers:


 * (1) exportUserData SHALL return a complete dataset containing all records


 *     from DynamoDB, all indexed documents from OpenSearch, and all files


 *     from S3 belonging to that user.


 * (2) After deleteAllUserData completes, all queries for that user across


 *     all stores SHALL return empty results.


 *


 * **Validates: Requirements REQ-7.3**


 */





import { describe, it, expect, vi, beforeEach } from 'vitest';


import fc from 'fast-check';


import type { ChatMessage, UserPreferences, DocumentChunk, FileMetadata } from '../types.js';





// ── Stateful mock stores ──


// These simulate the actual AWS backends so we can verify completeness.





let dynamoMessages: Map<string, ChatMessage[]>;


let dynamoPreferences: Map<string, UserPreferences>;


let openSearchDocs: Map<string, DocumentChunk[]>;


let s3Files: Map<string, FileMetadata[]>;





function resetStores() {


    dynamoMessages = new Map();


    dynamoPreferences = new Map();


    openSearchDocs = new Map();


    s3Files = new Map();


}





// Track whether deleteAllUserData has been called for a user


let _deletedUsers: Set<string>;





// ── Mock implementations ──





const mockDynamoSend = vi.fn().mockImplementation((cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {


    const cmdName = cmd.constructor.name;


    const input = cmd.input ?? (cmd as unknown as Record<string, unknown>);





    if (cmdName === 'MockQueryCommand') {


        const userId = (input as { ExpressionAttributeValues: Record<string, string> }).ExpressionAttributeValues[':uid'];


        const messages = dynamoMessages.get(userId) ?? [];


        return Promise.resolve({


            Items: messages.map((m) => ({ ...m, userId })),


            LastEvaluatedKey: undefined,


        });


    }





    if (cmdName === 'MockGetCommand') {


        const key = (input as { Key: Record<string, string> }).Key;


        const userId = key.userId;


        const prefs = dynamoPreferences.get(userId);


        return Promise.resolve({


            Item: prefs ? { userId, ...prefs } : undefined,


        });


    }





    if (cmdName === 'MockDeleteCommand') {


        const key = (input as { Key: Record<string, string> }).Key;


        const tableName = (input as { TableName: string }).TableName;


        const userId = key.userId;





        if (tableName === 'test-chat-messages') {


            const msgs = dynamoMessages.get(userId) ?? [];


            const timestamp = key.timestamp;


            dynamoMessages.set(userId, msgs.filter((m) => m.timestamp !== timestamp));


        } else if (tableName === 'test-user-preferences') {


            dynamoPreferences.delete(userId);


        }


        return Promise.resolve({});


    }





    return Promise.resolve({});


});





const mockS3Send = vi.fn().mockImplementation((cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {


    const cmdName = cmd.constructor.name;


    const input = cmd.input ?? (cmd as unknown as Record<string, unknown>);





    if (cmdName === 'MockListObjectsV2Command') {


        const prefix = (input as { Prefix: string }).Prefix;


        // Extract userId from prefix (format: "{userId}/...")


        const userId = prefix.split('/')[0];


        const files = s3Files.get(userId) ?? [];


        return Promise.resolve({


            Contents: files.map((f) => ({


                Key: f.key,


                Size: f.size,


                LastModified: new Date(f.lastModified),


            })),


            IsTruncated: false,


        });


    }





    if (cmdName === 'MockDeleteObjectCommand') {


        const key = (input as { Key: string }).Key;


        const userId = key.split('/')[0];


        const files = s3Files.get(userId) ?? [];


        s3Files.set(userId, files.filter((f) => f.key !== key));


        return Promise.resolve({});


    }





    return Promise.resolve({});


});





const mockOpenSearchSearch = vi.fn().mockImplementation((params: { body: { query: { bool: { filter: Array<{ term: { userId?: string } }> } } } }) => {


    const filters = params.body.query.bool.filter;


    const userIdFilter = filters.find((f) => f.term?.userId);


    const userId = userIdFilter?.term?.userId ?? '';


    const docs = openSearchDocs.get(userId) ?? [];





    return Promise.resolve({


        body: {


            hits: {


                hits: docs.map((d) => ({


                    _id: d.id ?? d.chunkId ?? String(Math.random()),


                    _source: { ...d, userId },


                })),


            },


        },


    });


});





const mockOpenSearchDeleteByQuery = vi.fn().mockImplementation((params: { body: { query: { bool: { filter: Array<{ term: { userId?: string } }> } } } }) => {


    const filters = params.body.query.bool.filter;


    const userIdFilter = filters.find((f) => f.term?.userId);


    const userId = userIdFilter?.term?.userId ?? '';


    openSearchDocs.set(userId, []);


    return Promise.resolve({ body: { deleted: 0 } });


});





vi.mock('@aws-sdk/client-dynamodb', () => ({


    DynamoDBClient: class MockDynamoDBClient { constructor() { /* noop */ } },


}));





vi.mock('@aws-sdk/lib-dynamodb', () => {


    class MockPutCommand {


        input: unknown;


        constructor(input: unknown) { this.input = input; }


    }


    class MockQueryCommand {


        input: unknown;


        constructor(input: unknown) { this.input = input; }


    }


    class MockGetCommand {


        input: unknown;


        constructor(input: unknown) { this.input = input; }


    }


    class MockDeleteCommand {


        input: unknown;


        constructor(input: unknown) { this.input = input; }


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


            constructor() { /* noop */ }


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


        constructor() { /* noop */ }


    },


}));





vi.mock('@aws-sdk/client-secrets-manager', () => ({


    SecretsManagerClient: class MockSecretsManagerClient { constructor() { /* noop */ } },


    GetSecretValueCommand: class MockGetSecretValueCommand { constructor() { /* noop */ } },


}));





vi.mock('@opensearch-project/opensearch', () => ({


    Client: class MockOpenSearchClient {


        search = mockOpenSearchSearch;


        deleteByQuery = mockOpenSearchDeleteByQuery;


        bulk = mockOpenSearchBulk;


        index = vi.fn().mockResolvedValue({ body: { result: 'created' } });


        indices = {


            exists: vi.fn().mockResolvedValue({ body: true }),


            create: vi.fn().mockResolvedValue({ body: { acknowledged: true } }),


            putMapping: vi.fn().mockResolvedValue({ body: { acknowledged: true } }),


        };


        constructor() { /* noop */ }


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





// ── Arbitraries ──





const arbUserId = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{2,35}$/);





const arbChatMessage: fc.Arbitrary<ChatMessage> = fc.record({


    messageId: fc.uuid(),


    role: fc.constantFrom('user' as const, 'assistant' as const),


    content: fc.string({ minLength: 1, maxLength: 200 }),


    timestamp: fc.date({


        min: new Date('2020-01-01T00:00:00Z'),


        max: new Date('2030-12-31T23:59:59Z'),


        noInvalidDate: true,


    }).map((d) => d.toISOString()),


});





const arbUserPreferences: fc.Arbitrary<UserPreferences> = fc.record({


    autoSave: fc.boolean(),


    notificationTime: fc.tuple(


        fc.integer({ min: 0, max: 23 }),


        fc.integer({ min: 0, max: 59 }),


    ).map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`),


    slideTemplate: fc.constantFrom('Corporate' as const, 'Modern' as const, 'Elegant' as const, 'Informative' as const),


    consentGiven: fc.constant(true),


    consentTimestamp: fc.date({


        min: new Date('2020-01-01T00:00:00Z'),


        max: new Date('2030-12-31T23:59:59Z'),


        noInvalidDate: true,


    }).map((d) => d.toISOString()),


});





const arbDocumentChunk: fc.Arbitrary<DocumentChunk> = fc.record({


    id: fc.uuid(),


    docType: fc.constantFrom('pdf', 'docx', 'csv', 'txt'),


    content: fc.string({ minLength: 1, maxLength: 100 }),


    contentVector: fc.array(fc.float({ min: -1, max: 1, noNaN: true }), { minLength: 10, maxLength: 10 }),


    filename: fc.stringMatching(/^[a-z0-9_-]{1,20}\.(pdf|docx|csv|txt)$/),


    pageNumber: fc.integer({ min: 1, max: 50 }),


    chunkIndex: fc.integer({ min: 0, max: 100 }),


    uploadedAt: fc.date({


        min: new Date('2020-01-01T00:00:00Z'),


        max: new Date('2030-12-31T23:59:59Z'),


        noInvalidDate: true,


    }).map((d) => d.toISOString()),


});





const arbFileMetadata = (userId: string): fc.Arbitrary<FileMetadata> =>


    fc.record({


        key: fc.stringMatching(/^[a-z0-9_-]{1,20}\.(pdf|docx|pptx|txt)$/).map(


            (name) => `${userId}/documents/${name}`,


        ),


        size: fc.integer({ min: 1, max: 10_000_000 }),


        lastModified: fc.date({


            min: new Date('2020-01-01T00:00:00Z'),


            max: new Date('2030-12-31T23:59:59Z'),


            noInvalidDate: true,


        }).map((d) => d.toISOString()),


    });





/**


 * Composite arbitrary that generates a user with data across all stores.


 */


interface UserData {


    userId: string;


    messages: ChatMessage[];


    preferences: UserPreferences | null;


    documents: DocumentChunk[];


    files: FileMetadata[];


}





const arbUserData: fc.Arbitrary<UserData> = arbUserId.chain((userId) =>


    fc.record({


        userId: fc.constant(userId),


        messages: fc.array(arbChatMessage, { minLength: 0, maxLength: 5 }),


        preferences: fc.option(arbUserPreferences, { nil: null }),


        documents: fc.array(arbDocumentChunk, { minLength: 0, maxLength: 5 }),


        files: fc.array(arbFileMetadata(userId), { minLength: 0, maxLength: 5 }),


    }),


);





describe('Feature: nanoclaw-aws-deployment, Property 8: PDPA data lifecycle', { timeout: 60_000 }, () => {


    beforeEach(() => {


        resetStores();


        _deletedUsers = new Set();


        vi.clearAllMocks();


    });





    it('exportUserData returns ALL records from DynamoDB, OpenSearch, and S3 for any user', async () => {


        await fc.assert(


            fc.asyncProperty(arbUserData, async (userData) => {


                resetStores();





                // Seed the mock stores with the generated data


                dynamoMessages.set(userData.userId, [...userData.messages]);


                if (userData.preferences) {


                    dynamoPreferences.set(userData.userId, userData.preferences);


                }


                openSearchDocs.set(userData.userId, [...userData.documents]);


                s3Files.set(userData.userId, [...userData.files]);





                const gateway = createGateway();


                const exportResult = await gateway.exportUserData(userData.userId);





                // Verify completeness: export contains ALL chat messages


                expect(exportResult.chatMessages).toHaveLength(userData.messages.length);


                for (const msg of userData.messages) {


                    expect(exportResult.chatMessages).toContainEqual(msg);


                }





                // Verify completeness: export contains preferences (or null)


                if (userData.preferences) {


                    expect(exportResult.preferences).toEqual(userData.preferences);


                } else {


                    expect(exportResult.preferences).toBeNull();


                }





                // Verify completeness: export contains ALL OpenSearch documents


                expect(exportResult.documents).toHaveLength(userData.documents.length);


                for (const doc of userData.documents) {


                    expect(exportResult.documents).toContainEqual(doc);


                }





                // Verify completeness: export contains ALL S3 files


                expect(exportResult.files).toHaveLength(userData.files.length);


                for (const file of userData.files) {


                    expect(exportResult.files).toContainEqual(file);


                }





                // Verify metadata


                expect(exportResult.userId).toBe(userData.userId);


                expect(exportResult.exportedAt).toBeDefined();


            }),


            { numRuns: 100 },


        );


    });





    it('after deleteAllUserData, all queries for that user return empty results', async () => {


        await fc.assert(


            fc.asyncProperty(arbUserData, async (userData) => {


                resetStores();





                // Seed the mock stores with the generated data


                dynamoMessages.set(userData.userId, [...userData.messages]);


                if (userData.preferences) {


                    dynamoPreferences.set(userData.userId, userData.preferences);


                }


                openSearchDocs.set(userData.userId, [...userData.documents]);


                s3Files.set(userData.userId, [...userData.files]);





                const gateway = createGateway();





                // Execute deletion


                const receipt = await gateway.deleteAllUserData(userData.userId);





                // Verify receipt counts match what was stored


                const expectedDynamoDeleted = userData.messages.length + (userData.preferences ? 1 : 0);


                expect(receipt.dynamoDbRecordsDeleted).toBe(expectedDynamoDeleted);


                expect(receipt.openSearchDocumentsDeleted).toBe(userData.documents.length);


                expect(receipt.s3ObjectsDeleted).toBe(userData.files.length);





                // Verify all stores are now empty for this user


                expect(dynamoMessages.get(userData.userId) ?? []).toHaveLength(0);


                expect(dynamoPreferences.has(userData.userId)).toBe(false);


                expect(openSearchDocs.get(userData.userId) ?? []).toHaveLength(0);


                expect(s3Files.get(userData.userId) ?? []).toHaveLength(0);





                // Verify subsequent queries return empty


                const exportAfterDelete = await gateway.exportUserData(userData.userId);


                expect(exportAfterDelete.chatMessages).toHaveLength(0);


                expect(exportAfterDelete.preferences).toBeNull();


                expect(exportAfterDelete.documents).toHaveLength(0);


                expect(exportAfterDelete.files).toHaveLength(0);


            }),


            { numRuns: 100 },


        );


    });


});


