/**
 * Unit tests for Data Gateway OpenSearch operations (task 2.3).
 * Mocks the OpenSearch client to verify correct query construction,
 * hybrid scoring, and userId isolation enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataGateway } from './index.js';
import type { DataGatewayConfig, DocumentChunk } from './types.js';

// Mock OpenSearch client methods
const mockIndex = vi.fn().mockResolvedValue({ body: { result: 'created' } });
const mockSearch = vi.fn();
const mockDeleteByQuery = vi.fn().mockResolvedValue({ body: { deleted: 1 } });
const mockIndicesExists = vi.fn().mockResolvedValue({ body: true });
const mockIndicesCreate = vi.fn().mockResolvedValue({ body: { acknowledged: true } });

// Mock all AWS SDK modules
vi.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: vi.fn().mockImplementation(function () { return {}; }),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: {
        from: vi.fn().mockReturnValue({ send: vi.fn() }),
    },
    PutCommand: vi.fn(),
    QueryCommand: vi.fn(),
    GetCommand: vi.fn(),
    DeleteCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: vi.fn().mockImplementation(function () { return {}; }),
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

vi.mock('@aws-sdk/credential-provider-node', () => ({
    defaultProvider: vi.fn().mockReturnValue(() => Promise.resolve({})),
}));

vi.mock('@opensearch-project/opensearch', () => ({
    Client: vi.fn().mockImplementation(function () {
        return {
            index: mockIndex,
            search: mockSearch,
            deleteByQuery: mockDeleteByQuery,
            indices: {
                exists: mockIndicesExists,
                create: mockIndicesCreate,
            },
        };
    }),
}));

vi.mock('@opensearch-project/opensearch/aws', () => ({
    AwsSigv4Signer: vi.fn().mockReturnValue({}),
}));

const testConfig: DataGatewayConfig = {
    region: 'ap-southeast-1',
    dynamoDb: {
        chatMessagesTable: 'test-chat-messages',
        webhookTokensTable: 'test-webhook-tokens',
        userPreferencesTable: 'test-user-preferences',
        systemErrorsTable: 'test-system-errors',
    },
    openSearch: {
        endpoint: 'https://test-opensearch.ap-southeast-1.aoss.amazonaws.com',
        indexName: 'documents',
    },
    s3: {
        dataBucket: 'test-data-bucket',
    },
};

describe('DataGateway OpenSearch operations', () => {
    let gateway: DataGateway;

    const sampleChunk: DocumentChunk = {
        id: 'chunk-001',
        docType: 'pdf',
        content: 'This is a test document about machine learning.',
        contentVector: new Array(1536).fill(0.1),
        filename: 'test-doc.pdf',
        pageNumber: 1,
        chunkIndex: 0,
        uploadedAt: '2024-01-15T10:00:00.000Z',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        gateway = DataGateway.createWithConfig(testConfig);
    });

    describe('ensureIndex', () => {
        it('does not create index if it already exists', async () => {
            mockIndicesExists.mockResolvedValueOnce({ body: true });

            await gateway.ensureIndex();

            expect(mockIndicesExists).toHaveBeenCalledWith({ index: 'documents' });
            expect(mockIndicesCreate).not.toHaveBeenCalled();
        });

        it('creates index with correct mappings if it does not exist', async () => {
            mockIndicesExists.mockResolvedValueOnce({ body: false });

            await gateway.ensureIndex();

            expect(mockIndicesCreate).toHaveBeenCalledWith({
                index: 'documents',
                body: expect.objectContaining({
                    settings: expect.objectContaining({
                        'index.knn': true,
                        'index.knn.algo_param.ef_search': 512,
                        number_of_shards: 2,
                        number_of_replicas: 1,
                    }),
                    mappings: expect.objectContaining({
                        properties: expect.objectContaining({
                            id: { type: 'keyword' },
                            userId: { type: 'keyword' },
                            docType: { type: 'keyword' },
                            content: { type: 'text', analyzer: 'standard' },
                            contentVector: {
                                type: 'knn_vector',
                                dimension: 1536,
                                method: {
                                    name: 'hnsw',
                                    space_type: 'cosinesimil',
                                    engine: 'nmslib',
                                },
                            },
                            filename: { type: 'keyword' },
                            pageNumber: { type: 'integer' },
                            chunkIndex: { type: 'integer' },
                            uploadedAt: { type: 'date' },
                        }),
                    }),
                }),
            });
        });

        it('creates index when exists check throws', async () => {
            mockIndicesExists.mockRejectedValueOnce(new Error('Not found'));

            await gateway.ensureIndex();

            expect(mockIndicesCreate).toHaveBeenCalled();
        });
    });

    describe('indexDocument', () => {
        it('indexes a document chunk with userId and all fields', async () => {
            await gateway.indexDocument('user-abc', sampleChunk);

            expect(mockIndex).toHaveBeenCalledWith({
                index: 'documents',
                id: 'chunk-001',
                body: {
                    id: 'chunk-001',
                    userId: 'user-abc',
                    docType: 'pdf',
                    content: 'This is a test document about machine learning.',
                    contentVector: sampleChunk.contentVector,
                    filename: 'test-doc.pdf',
                    pageNumber: 1,
                    chunkIndex: 0,
                    uploadedAt: '2024-01-15T10:00:00.000Z',
                },
                refresh: 'wait_for',
            });
        });

        it('rejects empty userId', async () => {
            await expect(gateway.indexDocument('', sampleChunk)).rejects.toThrow('userId is required');
            expect(mockIndex).not.toHaveBeenCalled();
        });

        it('rejects whitespace-only userId', async () => {
            await expect(gateway.indexDocument('   ', sampleChunk)).rejects.toThrow('userId is required');
            expect(mockIndex).not.toHaveBeenCalled();
        });
    });

    describe('hybridSearch', () => {
        it('executes both knn and BM25 queries with userId filter', async () => {
            const knnHits = [
                { _id: 'doc-1', _score: 0.95, _source: { content: 'ML content', filename: 'ml.pdf', pageNumber: 1, chunkIndex: 0 } },
                { _id: 'doc-2', _score: 0.80, _source: { content: 'AI content', filename: 'ai.pdf', pageNumber: 2, chunkIndex: 1 } },
            ];
            const bm25Hits = [
                { _id: 'doc-1', _score: 5.0, _source: { content: 'ML content', filename: 'ml.pdf', pageNumber: 1, chunkIndex: 0 } },
                { _id: 'doc-3', _score: 3.0, _source: { content: 'Data content', filename: 'data.pdf', pageNumber: 1, chunkIndex: 0 } },
            ];

            mockSearch
                .mockResolvedValueOnce({ body: { hits: { hits: knnHits } } })
                .mockResolvedValueOnce({ body: { hits: { hits: bm25Hits } } });

            const results = await gateway.hybridSearch('user-abc', 'machine learning', new Array(1536).fill(0.1), 3);

            // Verify both searches were called with userId filter
            expect(mockSearch).toHaveBeenCalledTimes(2);

            // First call: knn search — verify userId filter
            const knnCall = mockSearch.mock.calls[0][0];
            expect(knnCall.index).toBe('documents');
            expect(knnCall.body.query.bool.filter).toEqual([{ term: { userId: 'user-abc' } }]);
            expect(knnCall.body.query.bool.must[0].knn).toBeDefined();

            // Second call: BM25 search — verify userId filter
            const bm25Call = mockSearch.mock.calls[1][0];
            expect(bm25Call.index).toBe('documents');
            expect(bm25Call.body.query.bool.filter).toEqual([{ term: { userId: 'user-abc' } }]);
            expect(bm25Call.body.query.bool.must[0].match).toBeDefined();

            // Verify results are combined and sorted
            expect(results.length).toBe(3);
            expect(results[0].id).toBe('doc-1'); // Appears in both, highest combined score

            // doc-1: 0.7 * 0.95 + 0.3 * (5.0/5.0) = 0.665 + 0.3 = 0.965
            expect(results[0].score).toBeCloseTo(0.965, 2);
            expect(results[0].source).toBe('hybrid');
        });

        it('applies 70% vector + 30% BM25 weighting correctly', async () => {
            // Single doc in knn only
            mockSearch
                .mockResolvedValueOnce({
                    body: {
                        hits: {
                            hits: [
                                { _id: 'vec-only', _score: 0.8, _source: { content: 'Vector', filename: 'v.pdf', pageNumber: 1, chunkIndex: 0 } },
                            ]
                        }
                    }
                })
                .mockResolvedValueOnce({
                    body: {
                        hits: {
                            hits: [
                                { _id: 'kw-only', _score: 4.0, _source: { content: 'Keyword', filename: 'k.pdf', pageNumber: 1, chunkIndex: 0 } },
                            ]
                        }
                    }
                });

            const results = await gateway.hybridSearch('user-abc', 'test', new Array(1536).fill(0), 5);

            // vec-only: 0.7 * 0.8 = 0.56
            const vecResult = results.find(r => r.id === 'vec-only')!;
            expect(vecResult.score).toBeCloseTo(0.56, 2);
            expect(vecResult.source).toBe('vector');

            // kw-only: 0.3 * (4.0/4.0) = 0.3
            const kwResult = results.find(r => r.id === 'kw-only')!;
            expect(kwResult.score).toBeCloseTo(0.3, 2);
            expect(kwResult.source).toBe('keyword');
        });

        it('returns results ordered by combined score descending', async () => {
            const knnHits = [
                { _id: 'doc-a', _score: 0.5, _source: { content: 'A', filename: 'a.pdf', pageNumber: 1, chunkIndex: 0 } },
                { _id: 'doc-b', _score: 0.9, _source: { content: 'B', filename: 'b.pdf', pageNumber: 1, chunkIndex: 0 } },
            ];

            mockSearch
                .mockResolvedValueOnce({ body: { hits: { hits: knnHits } } })
                .mockResolvedValueOnce({ body: { hits: { hits: [] } } });

            const results = await gateway.hybridSearch('user-abc', 'test', new Array(1536).fill(0), 3);

            expect(results[0].id).toBe('doc-b'); // Higher vector score
            expect(results[1].id).toBe('doc-a');
            expect(results[0].score).toBeGreaterThan(results[1].score);
        });

        it('handles empty results gracefully', async () => {
            mockSearch
                .mockResolvedValueOnce({ body: { hits: { hits: [] } } })
                .mockResolvedValueOnce({ body: { hits: { hits: [] } } });

            const results = await gateway.hybridSearch('user-abc', 'nonexistent', new Array(1536).fill(0), 3);

            expect(results).toEqual([]);
        });

        it('limits results to topK', async () => {
            const knnHits = Array.from({ length: 5 }, (_, i) => ({
                _id: `doc-${i}`,
                _score: 0.9 - i * 0.1,
                _source: { content: `Content ${i}`, filename: `file${i}.pdf`, pageNumber: 1, chunkIndex: i },
            }));

            mockSearch
                .mockResolvedValueOnce({ body: { hits: { hits: knnHits } } })
                .mockResolvedValueOnce({ body: { hits: { hits: [] } } });

            const results = await gateway.hybridSearch('user-abc', 'test', new Array(1536).fill(0), 2);

            expect(results.length).toBe(2);
        });

        it('marks keyword-only results correctly', async () => {
            mockSearch
                .mockResolvedValueOnce({ body: { hits: { hits: [] } } })
                .mockResolvedValueOnce({
                    body: {
                        hits: {
                            hits: [
                                { _id: 'doc-kw', _score: 4.0, _source: { content: 'Keyword match', filename: 'kw.pdf', pageNumber: 1, chunkIndex: 0 } },
                            ]
                        }
                    }
                });

            const results = await gateway.hybridSearch('user-abc', 'keyword', new Array(1536).fill(0), 3);

            expect(results[0].source).toBe('keyword');
            expect(results[0].score).toBeCloseTo(0.3, 2); // 0.3 * (4.0/4.0) = 0.3
        });

        it('normalizes BM25 scores relative to max score', async () => {
            const bm25Hits = [
                { _id: 'doc-high', _score: 10.0, _source: { content: 'High', filename: 'h.pdf', pageNumber: 1, chunkIndex: 0 } },
                { _id: 'doc-low', _score: 2.0, _source: { content: 'Low', filename: 'l.pdf', pageNumber: 1, chunkIndex: 0 } },
            ];

            mockSearch
                .mockResolvedValueOnce({ body: { hits: { hits: [] } } })
                .mockResolvedValueOnce({ body: { hits: { hits: bm25Hits } } });

            const results = await gateway.hybridSearch('user-abc', 'test', new Array(1536).fill(0), 5);

            // doc-high: 0.3 * (10/10) = 0.3
            const highResult = results.find(r => r.id === 'doc-high')!;
            expect(highResult.score).toBeCloseTo(0.3, 2);

            // doc-low: 0.3 * (2/10) = 0.06
            const lowResult = results.find(r => r.id === 'doc-low')!;
            expect(lowResult.score).toBeCloseTo(0.06, 2);
        });

        it('rejects empty userId', async () => {
            await expect(
                gateway.hybridSearch('', 'query', new Array(1536).fill(0), 3),
            ).rejects.toThrow('userId is required');
            expect(mockSearch).not.toHaveBeenCalled();
        });
    });

    describe('deleteUserDocuments', () => {
        it('deletes all documents for a userId', async () => {
            await gateway.deleteUserDocuments('user-abc');

            expect(mockDeleteByQuery).toHaveBeenCalledWith({
                index: 'documents',
                body: {
                    query: {
                        bool: {
                            filter: [{ term: { userId: 'user-abc' } }],
                        },
                    },
                },
                refresh: true,
            });
        });

        it('deletes documents filtered by filename when provided', async () => {
            await gateway.deleteUserDocuments('user-abc', 'report.pdf');

            expect(mockDeleteByQuery).toHaveBeenCalledWith({
                index: 'documents',
                body: {
                    query: {
                        bool: {
                            filter: [
                                { term: { userId: 'user-abc' } },
                                { term: { filename: 'report.pdf' } },
                            ],
                        },
                    },
                },
                refresh: true,
            });
        });

        it('rejects empty userId', async () => {
            await expect(gateway.deleteUserDocuments('')).rejects.toThrow('userId is required');
            expect(mockDeleteByQuery).not.toHaveBeenCalled();
        });

        it('rejects whitespace-only userId', async () => {
            await expect(gateway.deleteUserDocuments('  ')).rejects.toThrow('userId is required');
            expect(mockDeleteByQuery).not.toHaveBeenCalled();
        });
    });
});
