/**
 * Property-Based Test: TTL epoch calculation (Property 2)
 *
 * For any valid creation timestamp, verify:
 * - Chat messages: TTL = timestamp + 7,776,000s (90 days)
 * - Webhook tokens: TTL ≈ Date.now()/1000 + 900s (15 minutes)
 * - System errors: TTL ≈ Date.now()/1000 + 2,592,000s (30 days)
 *
 * Feature: nanoclaw-aws-deployment, Property 2: TTL epoch calculation
 * **Validates: Requirements REQ-2.1**
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import type { ChatMessage, SystemError } from '../types.js';

// Use vi.hoisted so the mock function is available when vi.mock factories run
const { mockSend } = vi.hoisted(() => ({
    mockSend: vi.fn(),
}));

// Capture PutCommand input via a side-channel since vitest v4 has issues
// with accessing mock.calls on re-imported constructor mocks
const { capturedPutInputs } = vi.hoisted(() => ({
    capturedPutInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: class MockDynamoDBClient {
        constructor() { /* noop */ }
    },
}));

vi.mock('@aws-sdk/lib-dynamodb', () => {
    class MockPutCommand {
        constructor(input: Record<string, unknown>) {
            capturedPutInputs.push(input);
        }
    }
    class MockQueryCommand {
        constructor() { /* noop */ }
    }
    class MockGetCommand {
        constructor() { /* noop */ }
    }
    class MockDeleteCommand {
        constructor() { /* noop */ }
    }
    return {
        DynamoDBDocumentClient: {
            from: vi.fn().mockReturnValue({ send: mockSend }),
        },
        PutCommand: MockPutCommand,
        QueryCommand: MockQueryCommand,
        GetCommand: MockGetCommand,
        DeleteCommand: MockDeleteCommand,
    };
});

vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: class MockS3Client { constructor() { /* noop */ } },
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
    Client: class MockOpenSearchClient { constructor() { /* noop */ } },
}));

vi.mock('@opensearch-project/opensearch/aws', () => ({
    AwsSigv4Signer: vi.fn().mockReturnValue({}),
}));

vi.mock('@aws-sdk/credential-provider-node', () => ({
    defaultProvider: vi.fn().mockReturnValue(() => Promise.resolve({})),
}));

// Import after mocks are set up
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

// Arbitrary date generator constrained to 2020-2030, filtering out invalid dates
const dateArb = fc.date({
    min: new Date('2020-01-01T00:00:00.000Z'),
    max: new Date('2030-12-31T23:59:59.999Z'),
    noInvalidDate: true,
});

describe('Property 2: TTL epoch calculation', { timeout: 60_000 }, () => {
    let gateway: InstanceType<typeof DataGateway>;

    beforeEach(() => {
        vi.clearAllMocks();
        capturedPutInputs.length = 0;
        gateway = createGateway();
    });

    it('chat message TTL = floor(timestamp/1000) + 7,776,000s for any valid timestamp', async () => {
        await fc.assert(
            fc.asyncProperty(dateArb, async (date) => {
                mockSend.mockResolvedValueOnce({});
                capturedPutInputs.length = 0;

                const timestamp = date.toISOString();
                const msg: ChatMessage = {
                    messageId: `msg-${date.getTime()}`,
                    role: 'user',
                    content: 'test message',
                    timestamp,
                };

                await gateway.putChatMessage('user-prop-test', msg);

                const input = capturedPutInputs.at(-1)!;
                const item = input.Item as Record<string, unknown>;
                const expectedTtl = Math.floor(date.getTime() / 1000) + 7_776_000;

                expect(item.ttl).toBe(expectedTtl);
            }),
            { numRuns: 100 },
        );
    });

    it('webhook token TTL ≈ floor(Date.now()/1000) + 900s for any creation time', async () => {
        await fc.assert(
            fc.asyncProperty(dateArb, async (_date) => {
                mockSend.mockResolvedValueOnce({});
                capturedPutInputs.length = 0;

                const beforeEpoch = Math.floor(Date.now() / 1000);
                await gateway.createWebhookToken('user-prop-test', `hash-${_date.getTime()}`);
                const afterEpoch = Math.floor(Date.now() / 1000);

                const input = capturedPutInputs.at(-1)!;
                const item = input.Item as Record<string, unknown>;
                const ttl = item.ttl as number;

                // TTL should be within 2 seconds tolerance of now + 900
                expect(ttl).toBeGreaterThanOrEqual(beforeEpoch + 900);
                expect(ttl).toBeLessThanOrEqual(afterEpoch + 900);
            }),
            { numRuns: 100 },
        );
    });

    it('system error TTL ≈ floor(Date.now()/1000) + 2,592,000s for any creation time', async () => {
        await fc.assert(
            fc.asyncProperty(dateArb, async (_date) => {
                mockSend.mockResolvedValueOnce({});
                capturedPutInputs.length = 0;

                const error: SystemError = {
                    errorType: 'TEST_ERROR',
                    message: `Error at ${_date.toISOString()}`,
                };

                const beforeEpoch = Math.floor(Date.now() / 1000);
                await gateway.logSystemError('user-prop-test', error);
                const afterEpoch = Math.floor(Date.now() / 1000);

                const input = capturedPutInputs.at(-1)!;
                const item = input.Item as Record<string, unknown>;
                const ttl = item.ttl as number;

                // TTL should be within 2 seconds tolerance of now + 2,592,000
                expect(ttl).toBeGreaterThanOrEqual(beforeEpoch + 2_592_000);
                expect(ttl).toBeLessThanOrEqual(afterEpoch + 2_592_000);
            }),
            { numRuns: 100 },
        );
    });
});
