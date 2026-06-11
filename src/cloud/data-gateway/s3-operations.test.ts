/**
 * Unit tests for Data Gateway S3 operations (task 2.4).
 * Mocks the S3 client to verify correct command construction,
 * userId prefix isolation, path traversal prevention, and SSE-S3 encryption.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

// Use vi.hoisted so the mock function is available when vi.mock factories run
const { mockS3Send, mockUploadDone, uploadConstructorArgs } = vi.hoisted(() => ({
    mockS3Send: vi.fn(),
    mockUploadDone: vi.fn(),
    uploadConstructorArgs: [] as unknown[],
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: class MockDynamoDBClient {
        constructor() { /* noop */ }
    },
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

vi.mock('@aws-sdk/client-s3', () => {
    class MockPutObjectCommand { constructor(public input: unknown) { } }
    class MockGetObjectCommand { constructor(public input: unknown) { } }
    class MockListObjectsV2Command { constructor(public input: unknown) { } }
    class MockDeleteObjectCommand { constructor(public input: unknown) { } }
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
        done = mockUploadDone;
        constructor(params: unknown) {
            uploadConstructorArgs.push(params);
        }
    },
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: vi.fn(),
    GetSecretValueCommand: vi.fn(),
}));

vi.mock('@opensearch-project/opensearch', () => ({
    Client: class MockOpenSearchClient {
        constructor() { /* noop */ }
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

/** Helper to create a ReadableStream from a string */
function stringToReadableStream(content: string): ReadableStream {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    return new ReadableStream({
        start(controller) {
            controller.enqueue(data);
            controller.close();
        },
    });
}

/** Helper to create a large ReadableStream (> 5MB) */
function largeReadableStream(sizeBytes: number): ReadableStream {
    const chunk = Buffer.alloc(sizeBytes, 'x');
    return new ReadableStream({
        start(controller) {
            controller.enqueue(chunk);
            controller.close();
        },
    });
}

describe('DataGateway S3 operations', () => {
    let gateway: InstanceType<typeof DataGateway>;

    beforeEach(() => {
        vi.clearAllMocks();
        uploadConstructorArgs.length = 0;
        gateway = createGateway();
    });

    describe('userId prefix isolation', () => {
        it('rejects key that does not start with userId/', async () => {
            const stream = stringToReadableStream('test content');
            await expect(
                gateway.uploadFile('user-1', 'bucket', 'other-user/file.txt', stream),
            ).rejects.toThrow('does not start with userId prefix');
        });

        it('rejects key with path traversal (../)', async () => {
            const stream = stringToReadableStream('test content');
            await expect(
                gateway.uploadFile('user-1', 'bucket', 'user-1/../other-user/file.txt', stream),
            ).rejects.toThrow('path traversal detected');
        });

        it('rejects key with backslash path traversal (..\\)', async () => {
            const stream = stringToReadableStream('test content');
            await expect(
                gateway.uploadFile('user-1', 'bucket', 'user-1/..\\other-user/file.txt', stream),
            ).rejects.toThrow('path traversal detected');
        });

        it('rejects empty userId', async () => {
            const stream = stringToReadableStream('test content');
            await expect(
                gateway.uploadFile('', 'bucket', '/file.txt', stream),
            ).rejects.toThrow('userId is required');
        });

        it('rejects getFile with wrong userId prefix', async () => {
            await expect(
                gateway.getFile('user-1', 'bucket', 'user-2/secret.pdf'),
            ).rejects.toThrow('does not start with userId prefix');
        });

        it('rejects deleteFile with wrong userId prefix', async () => {
            await expect(
                gateway.deleteFile('user-1', 'bucket', 'user-2/secret.pdf'),
            ).rejects.toThrow('does not start with userId prefix');
        });
    });

    describe('uploadFile', () => {
        it('uses PutObjectCommand for small files (< 5MB) with SSE-S3', async () => {
            mockS3Send.mockResolvedValueOnce({});

            const content = 'Hello, world!';
            const stream = stringToReadableStream(content);

            const result = await gateway.uploadFile('user-1', 'bucket', 'user-1/documents/hello.txt', stream);

            expect(result).toBe('user-1/documents/hello.txt');
            expect(mockS3Send).toHaveBeenCalledTimes(1);

            // Verify the command passed to send
            const cmd = mockS3Send.mock.calls[0][0];
            expect(cmd.input).toEqual({
                Bucket: 'test-data-bucket',
                Key: 'user-1/documents/hello.txt',
                Body: expect.any(Buffer),
                ServerSideEncryption: 'AES256',
            });

            // Verify the body content
            expect(Buffer.from(cmd.input.Body).toString()).toBe(content);
        });

        it('uses Upload (multipart) for large files (> 5MB) with SSE-S3', async () => {
            mockUploadDone.mockResolvedValueOnce({});
            uploadConstructorArgs.length = 0;

            const size = 6 * 1024 * 1024; // 6MB
            const stream = largeReadableStream(size);

            const result = await gateway.uploadFile('user-1', 'bucket', 'user-1/staging/large-file.pdf', stream);

            expect(result).toBe('user-1/staging/large-file.pdf');
            expect(uploadConstructorArgs).toHaveLength(1);
            const uploadParams = uploadConstructorArgs[0] as { params: { Bucket: string; Key: string; ServerSideEncryption: string } };
            expect(uploadParams.params.Bucket).toBe('test-data-bucket');
            expect(uploadParams.params.Key).toBe('user-1/staging/large-file.pdf');
            expect(uploadParams.params.ServerSideEncryption).toBe('AES256');
            expect(mockUploadDone).toHaveBeenCalled();
        });

        it('uses config.s3.dataBucket regardless of bucket parameter', async () => {
            mockS3Send.mockResolvedValueOnce({});

            const stream = stringToReadableStream('data');
            await gateway.uploadFile('user-1', 'ignored-bucket', 'user-1/file.txt', stream);

            const cmd = mockS3Send.mock.calls[0][0];
            expect(cmd.input.Bucket).toBe('test-data-bucket');
        });

        it('returns the S3 key on success', async () => {
            mockS3Send.mockResolvedValueOnce({});

            const stream = stringToReadableStream('content');
            const key = await gateway.uploadFile('user-1', 'bucket', 'user-1/docs/report.pdf', stream);

            expect(key).toBe('user-1/docs/report.pdf');
        });
    });

    describe('getFile', () => {
        it('sends GetObjectCommand with correct bucket and key', async () => {
            const mockBody = {
                transformToWebStream: vi.fn().mockReturnValue(new ReadableStream()),
            };
            mockS3Send.mockResolvedValueOnce({ Body: mockBody });

            await gateway.getFile('user-1', 'bucket', 'user-1/documents/file.pdf');

            const cmd = mockS3Send.mock.calls[0][0];
            expect(cmd.input).toEqual({
                Bucket: 'test-data-bucket',
                Key: 'user-1/documents/file.pdf',
            });
        });

        it('returns a ReadableStream from transformToWebStream', async () => {
            const expectedStream = new ReadableStream();
            const mockBody = {
                transformToWebStream: vi.fn().mockReturnValue(expectedStream),
            };
            mockS3Send.mockResolvedValueOnce({ Body: mockBody });

            const result = await gateway.getFile('user-1', 'bucket', 'user-1/file.txt');

            expect(result).toBe(expectedStream);
            expect(mockBody.transformToWebStream).toHaveBeenCalled();
        });

        it('throws when Body is null/undefined', async () => {
            mockS3Send.mockResolvedValueOnce({ Body: undefined });

            await expect(
                gateway.getFile('user-1', 'bucket', 'user-1/missing.txt'),
            ).rejects.toThrow('file not found');
        });

        it('converts Node.js Readable to web ReadableStream', async () => {
            const nodeReadable = Readable.from(['hello']);
            mockS3Send.mockResolvedValueOnce({ Body: nodeReadable });

            const result = await gateway.getFile('user-1', 'bucket', 'user-1/file.txt');

            expect(result).toBeDefined();
            // Should be a web ReadableStream (has getReader method)
            expect(typeof (result as ReadableStream).getReader).toBe('function');
        });
    });

    describe('listFiles', () => {
        it('lists objects under userId/prefix', async () => {
            mockS3Send.mockResolvedValueOnce({
                Contents: [
                    { Key: 'user-1/documents/file1.pdf', Size: 1024, LastModified: new Date('2024-06-15T10:00:00Z') },
                    { Key: 'user-1/documents/file2.txt', Size: 512, LastModified: new Date('2024-06-14T08:00:00Z') },
                ],
                IsTruncated: false,
            });

            const result = await gateway.listFiles('user-1', 'documents/');

            const cmd = mockS3Send.mock.calls[0][0];
            expect(cmd.input).toEqual({
                Bucket: 'test-data-bucket',
                Prefix: 'user-1/documents/',
                ContinuationToken: undefined,
            });

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                key: 'user-1/documents/file1.pdf',
                size: 1024,
                lastModified: '2024-06-15T10:00:00.000Z',
            });
            expect(result[1]).toEqual({
                key: 'user-1/documents/file2.txt',
                size: 512,
                lastModified: '2024-06-14T08:00:00.000Z',
            });
        });

        it('handles pagination with ContinuationToken', async () => {
            mockS3Send
                .mockResolvedValueOnce({
                    Contents: [
                        { Key: 'user-1/docs/file1.pdf', Size: 100, LastModified: new Date('2024-01-01') },
                    ],
                    IsTruncated: true,
                    NextContinuationToken: 'token-page-2',
                })
                .mockResolvedValueOnce({
                    Contents: [
                        { Key: 'user-1/docs/file2.pdf', Size: 200, LastModified: new Date('2024-01-02') },
                    ],
                    IsTruncated: false,
                });

            const result = await gateway.listFiles('user-1', 'docs/');

            expect(mockS3Send).toHaveBeenCalledTimes(2);
            expect(result).toHaveLength(2);
            expect(result[0].key).toBe('user-1/docs/file1.pdf');
            expect(result[1].key).toBe('user-1/docs/file2.pdf');
        });

        it('returns empty array when no objects exist', async () => {
            mockS3Send.mockResolvedValueOnce({
                Contents: undefined,
                IsTruncated: false,
            });

            const result = await gateway.listFiles('user-1', 'empty-prefix/');
            expect(result).toEqual([]);
        });

        it('constructs prefix as userId/prefix', async () => {
            mockS3Send.mockResolvedValueOnce({ Contents: [], IsTruncated: false });

            await gateway.listFiles('user-abc', 'staging/uploads/');

            const cmd = mockS3Send.mock.calls[0][0];
            expect(cmd.input.Prefix).toBe('user-abc/staging/uploads/');
        });

        it('rejects empty userId', async () => {
            await expect(gateway.listFiles('', 'docs/')).rejects.toThrow('userId is required');
        });
    });

    describe('deleteFile', () => {
        it('sends DeleteObjectCommand with correct bucket and key', async () => {
            mockS3Send.mockResolvedValueOnce({});

            await gateway.deleteFile('user-1', 'bucket', 'user-1/documents/old-file.pdf');

            const cmd = mockS3Send.mock.calls[0][0];
            expect(cmd.input).toEqual({
                Bucket: 'test-data-bucket',
                Key: 'user-1/documents/old-file.pdf',
            });
        });

        it('uses config.s3.dataBucket regardless of bucket parameter', async () => {
            mockS3Send.mockResolvedValueOnce({});

            await gateway.deleteFile('user-1', 'some-other-bucket', 'user-1/file.txt');

            const cmd = mockS3Send.mock.calls[0][0];
            expect(cmd.input.Bucket).toBe('test-data-bucket');
        });

        it('rejects key not belonging to user', async () => {
            await expect(
                gateway.deleteFile('user-1', 'bucket', 'user-2/private.pdf'),
            ).rejects.toThrow('does not start with userId prefix');
        });

        it('rejects path traversal in key', async () => {
            await expect(
                gateway.deleteFile('user-1', 'bucket', 'user-1/../../etc/passwd'),
            ).rejects.toThrow('path traversal detected');
        });
    });
});
