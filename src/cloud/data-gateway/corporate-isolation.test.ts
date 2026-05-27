/**
 * Unit tests for data-isolation-corporate-docs spec — DataGateway core (Tasks 1.1–1.7).
 * Verifies CORPORATE sentinel handling: assertUserId rejection, hybridSearch corporate-inclusive
 * filter, indexCorporateDocument bypass, key validation read/write modes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockOsSearch, mockOsIndex } = vi.hoisted(() => ({
    mockOsSearch: vi.fn(),
    mockOsIndex: vi.fn(),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: vi.fn(function () { return {}; }),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: vi.fn().mockReturnValue({ send: vi.fn() }) },
    PutCommand: vi.fn(function (i) { return { _input: i }; }),
    QueryCommand: vi.fn(function (i) { return { _input: i }; }),
    GetCommand: vi.fn(function (i) { return { _input: i }; }),
    DeleteCommand: vi.fn(function (i) { return { _input: i }; }),
}));

vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: vi.fn(function () { return {}; }),
    PutObjectCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
    ListObjectsV2Command: vi.fn(),
    DeleteObjectCommand: vi.fn(),
}));

vi.mock('@aws-sdk/lib-storage', () => ({ Upload: vi.fn() }));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: vi.fn(),
    GetSecretValueCommand: vi.fn(),
}));

vi.mock('@opensearch-project/opensearch', () => ({
    Client: vi.fn(function () {
        return { search: mockOsSearch, index: mockOsIndex };
    }),
}));

vi.mock('@opensearch-project/opensearch/aws', () => ({
    AwsSigv4Signer: vi.fn().mockReturnValue({}),
}));

vi.mock('@aws-sdk/credential-provider-node', () => ({
    defaultProvider: vi.fn().mockReturnValue(() => Promise.resolve({})),
}));

const { DataGateway } = await import('./index.js');

function createGateway() {
    return DataGateway.createWithConfig({
        region: 'ap-southeast-1',
        dynamoDb: {
            chatMessagesTable: 't1',
            webhookTokensTable: 't2',
            userPreferencesTable: 't3',
            systemErrorsTable: 't4',
        },
        openSearch: { endpoint: 'https://x', indexName: 'documents' },
        s3: { dataBucket: 'b' },
    });
}

describe('CORPORATE sentinel — assertUserId rejection', () => {
    let gw: ReturnType<typeof createGateway>;
    beforeEach(() => {
        vi.clearAllMocks();
        gw = createGateway();
    });

    it('exposes the static CORPORATE_SENTINEL constant', () => {
        expect(DataGateway.CORPORATE_SENTINEL).toBe('CORPORATE');
    });

    it('rejects CORPORATE as a regular userId on indexDocument', async () => {
        await expect(gw.indexDocument('CORPORATE', {
            id: 'x',
            docType: 'pdf',
            content: 'c',
            contentVector: [0],
            filename: 'f.pdf',
            pageNumber: 1,
            chunkIndex: 0,
            uploadedAt: new Date().toISOString(),
        })).rejects.toThrow(/CORPORATE sentinel cannot be used as a regular userId/);
    });

    it('rejects CORPORATE on hybridSearch', async () => {
        await expect(gw.hybridSearch('CORPORATE', 'q', [0], 5))
            .rejects.toThrow(/CORPORATE sentinel cannot be used as a regular userId/);
    });

    it('rejects CORPORATE on deleteAllUserData', async () => {
        await expect(gw.deleteAllUserData('CORPORATE'))
            .rejects.toThrow(/CORPORATE sentinel cannot be used as a regular userId/);
    });
});

describe('CORPORATE sentinel — hybridSearch corporate-inclusive filter', () => {
    let gw: ReturnType<typeof createGateway>;
    beforeEach(() => {
        vi.clearAllMocks();
        mockOsSearch.mockResolvedValue({ body: { hits: { hits: [] } } });
        gw = createGateway();
    });

    it('applies corporate-inclusive bool.should filter on BOTH knn and bm25 queries', async () => {
        await gw.hybridSearch('user-123', 'invoice', [0.1, 0.2], 5);
        expect(mockOsSearch).toHaveBeenCalledTimes(2);

        for (const call of mockOsSearch.mock.calls) {
            const filter = call[0].body.query.bool.filter;
            expect(filter).toHaveLength(1);
            const boolShould = filter[0].bool;
            expect(boolShould.minimum_should_match).toBe(1);
            expect(boolShould.should).toEqual([
                { term: { userId: 'user-123' } },
                { term: { userId: 'CORPORATE' } },
            ]);
        }
    });
});

describe('CORPORATE sentinel — indexCorporateDocument bypass', () => {
    let gw: ReturnType<typeof createGateway>;
    beforeEach(() => {
        vi.clearAllMocks();
        mockOsIndex.mockResolvedValue({});
        gw = createGateway();
    });

    it('indexes a chunk with userId=CORPORATE without an explicit userId argument', async () => {
        const chunk = {
            id: 'corp-1',
            docType: 'pdf' as const,
            content: 'corp content',
            contentVector: [0.1, 0.2],
            filename: 'employee_handbook.pdf',
            pageNumber: 1,
            chunkIndex: 0,
            uploadedAt: '2026-01-01T00:00:00Z',
        };
        await gw.indexCorporateDocument(chunk);
        expect(mockOsIndex).toHaveBeenCalledTimes(1);
        const arg = mockOsIndex.mock.calls[0][0];
        expect(arg.id).toBe('corp-1');
        expect(arg.body.userId).toBe('CORPORATE');
        expect(arg.body.content).toBe('corp content');
    });

    it('rejects a chunk without an id', async () => {
        await expect(gw.indexCorporateDocument({
            id: '',
            docType: 'pdf',
            content: 'c',
            contentVector: [0],
            filename: 'f',
            pageNumber: 1,
            chunkIndex: 0,
            uploadedAt: 'now',
        } as never)).rejects.toThrow(/chunk\.id is required/);
    });
});

describe('CORPORATE sentinel — assertKeyBelongsToUser read/write modes', () => {
    let gw: ReturnType<typeof createGateway>;
    beforeEach(() => {
        vi.clearAllMocks();
        gw = createGateway();
    });

    it('rejects path traversal in any mode (uploadFile)', async () => {
        await expect(gw.uploadFile('user-123', 'b', 'user-123/../user-456/x.pdf', undefined as never))
            .rejects.toThrow(/path traversal detected/);
    });

    it('uploadFile (write mode) rejects corporate/ prefix from regular users', async () => {
        await expect(gw.uploadFile('user-123', 'b', 'corporate/handbook.pdf', undefined as never))
            .rejects.toThrow(/does not start with userId prefix/);
    });

    it('deleteFile (write mode) rejects corporate/ prefix from regular users', async () => {
        await expect(gw.deleteFile('user-123', 'b', 'corporate/handbook.pdf'))
            .rejects.toThrow(/does not start with userId prefix/);
    });

    it('getFile (read mode) accepts corporate/ prefix', async () => {
        // Passes assertKeyBelongsToUser; will fail later on actual S3 call (mocked S3Client returns {}).
        // We only assert the validation step passes, not the actual S3 fetch.
        // Use a try/catch to differentiate the two failure modes.
        let validationError: Error | null = null;
        try {
            await gw.getFile('user-123', 'b', 'corporate/handbook.pdf');
        } catch (e) {
            const msg = (e as Error).message;
            if (/does not start with userId prefix/.test(msg)) {
                validationError = e as Error;
            }
            // else: failure happened later in S3 client — fine for our purposes.
        }
        expect(validationError).toBeNull();
    });

    it('getFile (read mode) rejects keys belonging to OTHER users', async () => {
        await expect(gw.getFile('user-123', 'b', 'user-456/x.pdf'))
            .rejects.toThrow(/does not start with userId prefix/);
    });
});
