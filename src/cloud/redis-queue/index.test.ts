/**
 * Unit tests for Redis Message Queue (task 4.1).
 * Mocks ioredis to verify correct Redis command construction,
 * key patterns, serialization, and backpressure logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueueMessage, AgentResponse, DLQEntry } from './types.js';

// Mock ioredis with vi.hoisted for proper hoisting
const { mockRedisInstance, mockBlockingRedisInstance, MockRedis } = vi.hoisted(() => {
    const createMockRedis = () => ({
        connect: vi.fn().mockResolvedValue(undefined),
        quit: vi.fn().mockResolvedValue('OK'),
        lpush: vi.fn().mockResolvedValue(1),
        brpop: vi.fn().mockResolvedValue(null),
        rpop: vi.fn().mockResolvedValue(null),
        llen: vi.fn().mockResolvedValue(0),
        scan: vi.fn().mockResolvedValue(['0', []]),
    });

    const main = createMockRedis();
    const blocking = createMockRedis();
    let callCount = 0;

    // Use a real function constructor so `new Redis(...)` works
    function MockRedisConstructor() {
        callCount++;
        const instance = callCount % 2 === 1 ? main : blocking;
        return instance;
    }

    // Expose a way to reset the call count
    (MockRedisConstructor as unknown as { resetCallCount: () => void }).resetCallCount = () => { callCount = 0; };

    return {
        mockRedisInstance: main,
        mockBlockingRedisInstance: blocking,
        MockRedis: MockRedisConstructor,
    };
});

vi.mock('ioredis', () => ({
    default: MockRedis,
}));

// Import after mocks
const { MessageQueue } = await import('./index.js');

function createMessage(overrides?: Partial<QueueMessage>): QueueMessage {
    return {
        id: 'msg-001',
        userId: 'user-1',
        type: 'chat',
        payload: { text: 'Hello' },
        timestamp: '2024-06-15T10:30:00.000Z',
        ...overrides,
    };
}

function createResponse(overrides?: Partial<AgentResponse>): AgentResponse {
    return {
        id: 'resp-001',
        userId: 'user-1',
        type: 'chat_reply',
        payload: { text: 'Hi there' },
        timestamp: '2024-06-15T10:30:01.000Z',
        ...overrides,
    };
}

describe('MessageQueue', () => {
    let queue: InstanceType<typeof MessageQueue>;

    beforeEach(() => {
        vi.clearAllMocks();
        (MockRedis as unknown as { resetCallCount: () => void }).resetCallCount();
        queue = new MessageQueue({
            host: 'localhost',
            port: 6379,
            password: 'secret',
        });
    });

    describe('lifecycle', () => {
        it('connect() initializes both Redis connections', async () => {
            await queue.connect();

            expect(mockRedisInstance.connect).toHaveBeenCalledOnce();
            expect(mockBlockingRedisInstance.connect).toHaveBeenCalledOnce();
        });

        it('disconnect() quits both Redis connections', async () => {
            await queue.connect();
            await queue.disconnect();

            expect(mockRedisInstance.quit).toHaveBeenCalledOnce();
            expect(mockBlockingRedisInstance.quit).toHaveBeenCalledOnce();
        });

        it('throws if operations called before connect()', async () => {
            const msg = createMessage();
            await expect(queue.enqueueForAgent('user-1', msg)).rejects.toThrow('not connected');
        });
    });

    describe('enqueueForAgent', () => {
        beforeEach(async () => {
            await queue.connect();
        });

        it('pushes JSON-serialized message to correct Redis key', async () => {
            const msg = createMessage();
            await queue.enqueueForAgent('user-1', msg);

            expect(mockRedisInstance.lpush).toHaveBeenCalledWith(
                'queue:agent:user-1:inbound',
                JSON.stringify(msg),
            );
        });

        it('rejects empty userId', async () => {
            const msg = createMessage();
            await expect(queue.enqueueForAgent('', msg)).rejects.toThrow('userId is required');
        });

        it('rejects whitespace-only userId', async () => {
            const msg = createMessage();
            await expect(queue.enqueueForAgent('   ', msg)).rejects.toThrow('userId is required');
        });

        it('uses key prefix when configured', async () => {
            (MockRedis as unknown as { resetCallCount: () => void }).resetCallCount();
            const prefixedQueue = new MessageQueue({
                host: 'localhost',
                port: 6379,
                keyPrefix: 'prod',
            });
            await prefixedQueue.connect();

            const msg = createMessage();
            await prefixedQueue.enqueueForAgent('user-1', msg);

            expect(mockRedisInstance.lpush).toHaveBeenCalledWith(
                'prod:queue:agent:user-1:inbound',
                JSON.stringify(msg),
            );
        });
    });

    describe('dequeueForAgent', () => {
        beforeEach(async () => {
            await queue.connect();
        });

        it('uses BRPOP with correct key and timeout', async () => {
            mockBlockingRedisInstance.brpop.mockResolvedValueOnce(null);

            await queue.dequeueForAgent('user-1', 5);

            expect(mockBlockingRedisInstance.brpop).toHaveBeenCalledWith(
                'queue:agent:user-1:inbound',
                5,
            );
        });

        it('returns parsed message when available', async () => {
            const msg = createMessage();
            mockBlockingRedisInstance.brpop.mockResolvedValueOnce([
                'queue:agent:user-1:inbound',
                JSON.stringify(msg),
            ]);

            const result = await queue.dequeueForAgent('user-1', 5);

            expect(result).toEqual(msg);
        });

        it('returns null on timeout (no message)', async () => {
            mockBlockingRedisInstance.brpop.mockResolvedValueOnce(null);

            const result = await queue.dequeueForAgent('user-1', 1);

            expect(result).toBeNull();
        });

        it('rejects empty userId', async () => {
            await expect(queue.dequeueForAgent('', 5)).rejects.toThrow('userId is required');
        });
    });

    describe('enqueueResponse', () => {
        beforeEach(async () => {
            await queue.connect();
        });

        it('pushes response to orchestrator responses key', async () => {
            const resp = createResponse();
            await queue.enqueueResponse('user-1', resp);

            expect(mockRedisInstance.lpush).toHaveBeenCalledWith(
                'queue:orchestrator:responses',
                JSON.stringify(resp),
            );
        });

        it('rejects empty userId', async () => {
            const resp = createResponse();
            await expect(queue.enqueueResponse('', resp)).rejects.toThrow('userId is required');
        });
    });

    describe('dequeueResponse', () => {
        beforeEach(async () => {
            await queue.connect();
        });

        it('uses BRPOP on orchestrator responses key', async () => {
            mockBlockingRedisInstance.brpop.mockResolvedValueOnce(null);

            await queue.dequeueResponse(10);

            expect(mockBlockingRedisInstance.brpop).toHaveBeenCalledWith(
                'queue:orchestrator:responses',
                10,
            );
        });

        it('returns parsed response when available', async () => {
            const resp = createResponse();
            mockBlockingRedisInstance.brpop.mockResolvedValueOnce([
                'queue:orchestrator:responses',
                JSON.stringify(resp),
            ]);

            const result = await queue.dequeueResponse(5);

            expect(result).toEqual(resp);
        });

        it('returns null on timeout', async () => {
            mockBlockingRedisInstance.brpop.mockResolvedValueOnce(null);

            const result = await queue.dequeueResponse(1);

            expect(result).toBeNull();
        });
    });

    describe('moveToDLQ', () => {
        beforeEach(async () => {
            await queue.connect();
        });

        it('pushes message with error info to DLQ key', async () => {
            const msg = createMessage({ userId: 'user-1' });
            await queue.moveToDLQ(msg, 'Processing timeout');

            expect(mockRedisInstance.lpush).toHaveBeenCalledOnce();

            const [key, value] = mockRedisInstance.lpush.mock.calls[0];
            expect(key).toBe('queue:dlq:user-1');

            const entry = JSON.parse(value) as DLQEntry;
            expect(entry.message).toEqual(msg);
            expect(entry.error).toBe('Processing timeout');
            expect(entry.retryCount).toBe(1);
            expect(entry.movedAt).toBeDefined();
        });

        it('increments retry count from existing message retryCount', async () => {
            const msg = createMessage({ userId: 'user-1', retryCount: 2 });
            await queue.moveToDLQ(msg, 'Another failure');

            const [, value] = mockRedisInstance.lpush.mock.calls[0];
            const entry = JSON.parse(value) as DLQEntry;
            expect(entry.retryCount).toBe(3);
        });

        it('rejects message with empty userId', async () => {
            const msg = createMessage({ userId: '' });
            await expect(queue.moveToDLQ(msg, 'error')).rejects.toThrow('userId is required');
        });
    });

    describe('retryFromDLQ', () => {
        beforeEach(async () => {
            await queue.connect();
        });

        it('returns 0 when no DLQ keys exist', async () => {
            mockRedisInstance.scan.mockResolvedValueOnce(['0', []]);

            const count = await queue.retryFromDLQ();

            expect(count).toBe(0);
        });

        it('re-enqueues messages with retryCount < 3', async () => {
            const entry: DLQEntry = {
                message: createMessage({ userId: 'user-1' }),
                error: 'timeout',
                movedAt: '2024-06-15T10:00:00Z',
                retryCount: 1,
            };

            mockRedisInstance.scan.mockResolvedValueOnce(['0', ['queue:dlq:user-1']]);
            mockRedisInstance.llen.mockResolvedValueOnce(1);
            mockRedisInstance.rpop.mockResolvedValueOnce(JSON.stringify(entry));

            const count = await queue.retryFromDLQ();

            expect(count).toBe(1);

            // Verify the message was re-enqueued to the agent's inbound queue
            expect(mockRedisInstance.lpush).toHaveBeenCalledWith(
                'queue:agent:user-1:inbound',
                expect.any(String),
            );

            // Verify retry count was preserved
            const reEnqueuedMsg = JSON.parse(mockRedisInstance.lpush.mock.calls[0][1]) as QueueMessage;
            expect(reEnqueuedMsg.retryCount).toBe(1);
        });

        it('skips messages with retryCount >= 3 (puts back in DLQ)', async () => {
            const entry: DLQEntry = {
                message: createMessage({ userId: 'user-1' }),
                error: 'permanent failure',
                movedAt: '2024-06-15T10:00:00Z',
                retryCount: 3,
            };

            mockRedisInstance.scan.mockResolvedValueOnce(['0', ['queue:dlq:user-1']]);
            mockRedisInstance.llen.mockResolvedValueOnce(1);
            mockRedisInstance.rpop.mockResolvedValueOnce(JSON.stringify(entry));

            const count = await queue.retryFromDLQ();

            expect(count).toBe(0);

            // Verify the message was put back in DLQ (not re-enqueued to inbound)
            expect(mockRedisInstance.lpush).toHaveBeenCalledWith(
                'queue:dlq:user-1',
                JSON.stringify(entry),
            );
        });

        it('handles multiple DLQ entries with mixed retry counts', async () => {
            const retryable: DLQEntry = {
                message: createMessage({ userId: 'user-1', id: 'msg-retryable' }),
                error: 'timeout',
                movedAt: '2024-06-15T10:00:00Z',
                retryCount: 2,
            };
            const permanent: DLQEntry = {
                message: createMessage({ userId: 'user-1', id: 'msg-permanent' }),
                error: 'fatal',
                movedAt: '2024-06-15T09:00:00Z',
                retryCount: 3,
            };

            mockRedisInstance.scan.mockResolvedValueOnce(['0', ['queue:dlq:user-1']]);
            mockRedisInstance.llen.mockResolvedValueOnce(2);
            mockRedisInstance.rpop
                .mockResolvedValueOnce(JSON.stringify(retryable))
                .mockResolvedValueOnce(JSON.stringify(permanent));

            const count = await queue.retryFromDLQ();

            expect(count).toBe(1);
        });
    });

    describe('getQueueDepth', () => {
        beforeEach(async () => {
            await queue.connect();
        });

        it('returns LLEN of the agent inbound queue', async () => {
            mockRedisInstance.llen.mockResolvedValueOnce(42);

            const depth = await queue.getQueueDepth('user-1');

            expect(mockRedisInstance.llen).toHaveBeenCalledWith('queue:agent:user-1:inbound');
            expect(depth).toBe(42);
        });

        it('returns 0 for empty queue', async () => {
            mockRedisInstance.llen.mockResolvedValueOnce(0);

            const depth = await queue.getQueueDepth('user-1');

            expect(depth).toBe(0);
        });

        it('rejects empty userId', async () => {
            await expect(queue.getQueueDepth('')).rejects.toThrow('userId is required');
        });
    });

    describe('isBackpressured', () => {
        beforeEach(async () => {
            await queue.connect();
        });

        it('returns false when depth < 100', async () => {
            mockRedisInstance.llen.mockResolvedValueOnce(99);

            const result = await queue.isBackpressured('user-1');

            expect(result).toBe(false);
        });

        it('returns true when depth = 100', async () => {
            mockRedisInstance.llen.mockResolvedValueOnce(100);

            const result = await queue.isBackpressured('user-1');

            expect(result).toBe(true);
        });

        it('returns true when depth > 100', async () => {
            mockRedisInstance.llen.mockResolvedValueOnce(150);

            const result = await queue.isBackpressured('user-1');

            expect(result).toBe(true);
        });
    });
});
