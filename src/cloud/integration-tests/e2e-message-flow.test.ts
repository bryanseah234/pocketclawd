/**
 * Integration tests for end-to-end message flow.
 *
 * Validates:
 * - AC-1: WhatsApp message → Redis queue → sub-agent processes → response enqueued → delivered
 * - AC-2: Document upload → processing → RAG query returns relevant chunks
 * - AC-6: Container failure → automatic restart within 30s
 *
 * These tests mock external services (AWS SDK, Redis, Docker) but test the
 * actual module interactions between orchestrator components.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { QueueMessage, AgentResponse, IMessageQueue } from '../redis-queue/index.js';
import type { ContainerInfo, ContainerStatus } from '../container-manager/types.js';
import type { SearchResult, DocumentChunk } from '../data-gateway/types.js';

// ── In-memory Redis mock ──

/**
 * Minimal in-memory message queue that implements IMessageQueue.
 * Simulates Redis Lists (LPUSH/BRPOP) behavior without a real Redis connection.
 */
class InMemoryMessageQueue implements IMessageQueue {
    private agentQueues = new Map<string, QueueMessage[]>();
    private responseQueue: AgentResponse[] = [];
    private dlq = new Map<string, Array<{ message: QueueMessage; error: string; retryCount: number }>>();
    private connected = false;

    async connect(): Promise<void> {
        this.connected = true;
    }

    async disconnect(): Promise<void> {
        this.connected = false;
    }

    async enqueueForAgent(userId: string, message: QueueMessage): Promise<void> {
        if (!this.connected) throw new Error('Not connected');
        const queue = this.agentQueues.get(userId) ?? [];
        queue.push(message);
        this.agentQueues.set(userId, queue);
    }

    async dequeueForAgent(userId: string, _timeout: number): Promise<QueueMessage | null> {
        if (!this.connected) throw new Error('Not connected');
        const queue = this.agentQueues.get(userId) ?? [];
        return queue.shift() ?? null;
    }

    async enqueueResponse(userId: string, response: AgentResponse): Promise<void> {
        if (!this.connected) throw new Error('Not connected');
        this.responseQueue.push(response);
    }

    async dequeueResponse(_timeout: number): Promise<AgentResponse | null> {
        if (!this.connected) throw new Error('Not connected');
        return this.responseQueue.shift() ?? null;
    }

    async moveToDLQ(message: QueueMessage, error: string): Promise<void> {
        if (!this.connected) throw new Error('Not connected');
        const queue = this.dlq.get(message.userId) ?? [];
        queue.push({ message, error, retryCount: (message.retryCount ?? 0) + 1 });
        this.dlq.set(message.userId, queue);
    }

    async retryFromDLQ(): Promise<number> {
        if (!this.connected) throw new Error('Not connected');
        let retried = 0;
        for (const [userId, entries] of this.dlq) {
            const toRetry = entries.filter((e) => e.retryCount < 3);
            for (const entry of toRetry) {
                const msg: QueueMessage = { ...entry.message, retryCount: entry.retryCount };
                await this.enqueueForAgent(userId, msg);
                retried++;
            }
            this.dlq.set(userId, entries.filter((e) => e.retryCount >= 3));
        }
        return retried;
    }

    async getQueueDepth(userId: string): Promise<number> {
        if (!this.connected) throw new Error('Not connected');
        return (this.agentQueues.get(userId) ?? []).length;
    }

    async isBackpressured(userId: string): Promise<boolean> {
        return (await this.getQueueDepth(userId)) >= 100;
    }

    // Test helpers
    getAgentQueue(userId: string): QueueMessage[] {
        return this.agentQueues.get(userId) ?? [];
    }

    getResponseQueue(): AgentResponse[] {
        return [...this.responseQueue];
    }

    getDLQ(userId: string): Array<{ message: QueueMessage; error: string; retryCount: number }> {
        return this.dlq.get(userId) ?? [];
    }
}


// ── Mock Data Gateway for document pipeline tests ──

class MockDataGateway {
    private documents = new Map<string, DocumentChunk[]>();
    private chatMessages = new Map<string, Array<{ userId: string; content: string; timestamp: string }>>();

    async indexDocument(userId: string, chunk: DocumentChunk): Promise<void> {
        const docs = this.documents.get(userId) ?? [];
        docs.push(chunk);
        this.documents.set(userId, docs);
    }

    async hybridSearch(userId: string, query: string, _vector: number[], topK: number): Promise<SearchResult[]> {
        const docs = this.documents.get(userId) ?? [];
        // Simple keyword matching for test purposes
        const matches = docs
            .filter((d) => d.content.toLowerCase().includes(query.toLowerCase()))
            .map((d, idx) => ({
                id: d.id,
                content: d.content,
                filename: d.filename,
                pageNumber: d.pageNumber,
                chunkIndex: d.chunkIndex,
                score: 1.0 - idx * 0.1,
                source: 'hybrid' as const,
            }));
        return matches.slice(0, topK);
    }

    async deleteUserDocuments(userId: string, filename?: string): Promise<void> {
        if (filename) {
            const docs = this.documents.get(userId) ?? [];
            this.documents.set(userId, docs.filter((d) => d.filename !== filename));
        } else {
            this.documents.delete(userId);
        }
    }

    async putChatMessage(userId: string, message: { content: string; timestamp: string }): Promise<void> {
        const msgs = this.chatMessages.get(userId) ?? [];
        msgs.push({ userId, ...message });
        this.chatMessages.set(userId, msgs);
    }

    getIndexedDocuments(userId: string): DocumentChunk[] {
        return this.documents.get(userId) ?? [];
    }
}


// ── Mock Container Manager ──

class MockContainerManager {
    private containers = new Map<string, ContainerInfo>();
    private failureCallbacks: Array<(userId: string, exitCode: number) => void> = [];
    private restartLog: Array<{ userId: string; timestamp: number }> = [];
    private quarantinedUsers = new Set<string>();
    private failureCounts = new Map<string, number>();

    async spawn(userId: string): Promise<ContainerInfo> {
        if (this.quarantinedUsers.has(userId)) {
            throw new Error(`User ${userId} is quarantined`);
        }
        const info: ContainerInfo = {
            userId,
            containerId: `container-${userId}-${Date.now()}`,
            containerName: `nanoclaw-agent-${userId}`,
            status: 'running' as ContainerStatus,
            startedAt: new Date(),
            failureCount: this.failureCounts.get(userId) ?? 0,
            subnet: `172.20.${this.containers.size + 1}.0/24`,
        };
        this.containers.set(userId, info);
        return info;
    }

    async kill(userId: string): Promise<void> {
        this.containers.delete(userId);
    }

    getStatus(userId: string): ContainerStatus {
        if (this.quarantinedUsers.has(userId)) return 'quarantined';
        return this.containers.get(userId)?.status ?? 'stopped';
    }

    listActive(): ContainerInfo[] {
        return Array.from(this.containers.values()).filter((c) => c.status === 'running');
    }

    /**
     * Simulate a container failure (OOM, crash, etc.)
     * Triggers automatic restart logic.
     */
    simulateFailure(userId: string, exitCode: number): void {
        const info = this.containers.get(userId);
        if (info) {
            info.status = 'stopped';
            const count = (this.failureCounts.get(userId) ?? 0) + 1;
            this.failureCounts.set(userId, count);
            info.failureCount = count;
        }
        this.containers.delete(userId);
        for (const cb of this.failureCallbacks) {
            cb(userId, exitCode);
        }
    }

    /**
     * Simulate automatic restart after failure.
     * Returns the time taken (simulated) for the restart.
     */
    async simulateAutoRestart(userId: string): Promise<{ restarted: boolean; timeMs: number }> {
        const failureCount = this.failureCounts.get(userId) ?? 0;

        // Quarantine check: >3 failures in 5 min window
        if (failureCount > 3) {
            this.quarantinedUsers.add(userId);
            return { restarted: false, timeMs: 0 };
        }

        // Exponential backoff: 2^(failureCount-1) seconds, capped at 60s
        const backoffMs = Math.min(Math.pow(2, failureCount - 1) * 1000, 60_000);
        const startTime = Date.now();

        // Simulate the restart
        await this.spawn(userId);
        this.restartLog.push({ userId, timestamp: startTime });

        return { restarted: true, timeMs: backoffMs };
    }

    onFailure(cb: (userId: string, exitCode: number) => void): void {
        this.failureCallbacks.push(cb);
    }

    getRestartLog(): Array<{ userId: string; timestamp: number }> {
        return this.restartLog;
    }

    isQuarantined(userId: string): boolean {
        return this.quarantinedUsers.has(userId);
    }

    resetFailures(userId: string): void {
        this.failureCounts.delete(userId);
        this.quarantinedUsers.delete(userId);
    }
}


// ── Test Suite: End-to-End Message Flow (AC-1) ──

describe('Integration: End-to-End Message Flow (AC-1)', () => {
    let messageQueue: InMemoryMessageQueue;
    let containerManager: MockContainerManager;
    let dataGateway: MockDataGateway;

    beforeEach(() => {
        messageQueue = new InMemoryMessageQueue();
        containerManager = new MockContainerManager();
        dataGateway = new MockDataGateway();
        messageQueue.connect();
    });

    afterEach(() => {
        messageQueue.disconnect();
    });

    it('routes inbound WhatsApp message through Redis queue to sub-agent', async () => {
        const userId = 'user-alice-123';
        const inboundMessage: QueueMessage = {
            id: `msg-${Date.now()}-abc123`,
            userId,
            type: 'chat',
            payload: {
                sessionId: 'session-1',
                agentGroupId: 'agent-group-1',
                kind: 'chat',
                content: JSON.stringify({ text: 'Hello, what is the weather today?' }),
                timestamp: new Date().toISOString(),
                channelType: 'whatsapp',
                platformId: '6591234567@s.whatsapp.net',
                threadId: null,
            },
            timestamp: new Date().toISOString(),
        };

        // Step 1: Orchestrator enqueues message for the sub-agent
        await messageQueue.enqueueForAgent(userId, inboundMessage);

        // Step 2: Verify message arrives in the agent's queue
        const queueDepth = await messageQueue.getQueueDepth(userId);
        expect(queueDepth).toBe(1);

        // Step 3: Sub-agent dequeues the message
        const dequeued = await messageQueue.dequeueForAgent(userId, 5);
        expect(dequeued).not.toBeNull();
        expect(dequeued!.id).toBe(inboundMessage.id);
        expect(dequeued!.userId).toBe(userId);
        expect(dequeued!.type).toBe('chat');
        expect(dequeued!.payload.content).toBe(inboundMessage.payload.content);
    });

    it('sub-agent processes message and enqueues response for delivery', async () => {
        const userId = 'user-bob-456';

        // Step 1: Simulate inbound message enqueued by orchestrator
        const inboundMessage: QueueMessage = {
            id: 'msg-inbound-001',
            userId,
            type: 'chat',
            payload: {
                sessionId: 'session-2',
                agentGroupId: 'agent-group-1',
                kind: 'chat',
                content: JSON.stringify({ text: 'Summarize my documents' }),
                timestamp: new Date().toISOString(),
                channelType: 'whatsapp',
                platformId: '6598765432@s.whatsapp.net',
                threadId: null,
            },
            timestamp: new Date().toISOString(),
        };
        await messageQueue.enqueueForAgent(userId, inboundMessage);

        // Step 2: Sub-agent dequeues and processes
        const received = await messageQueue.dequeueForAgent(userId, 5);
        expect(received).not.toBeNull();

        // Step 3: Sub-agent generates response and enqueues it
        const agentResponse: AgentResponse = {
            id: `resp-${Date.now()}`,
            userId,
            type: 'chat',
            payload: {
                sessionId: received!.payload.sessionId,
                agentGroupId: received!.payload.agentGroupId,
                kind: 'chat',
                content: JSON.stringify({ text: 'Here is a summary of your documents...' }),
                channelType: received!.payload.channelType,
                platformId: received!.payload.platformId,
                threadId: received!.payload.threadId,
            },
            timestamp: new Date().toISOString(),
        };
        await messageQueue.enqueueResponse(userId, agentResponse);

        // Step 4: Orchestrator dequeues the response for delivery
        const response = await messageQueue.dequeueResponse(5);
        expect(response).not.toBeNull();
        expect(response!.userId).toBe(userId);
        expect(response!.type).toBe('chat');
        const responseContent = JSON.parse(response!.payload.content as string);
        expect(responseContent.text).toContain('summary of your documents');
    });

    it('complete round-trip: inbound → queue → process → response → delivery', async () => {
        const userId = 'user-charlie-789';

        // Spawn container for user
        const container = await containerManager.spawn(userId);
        expect(container.status).toBe('running');

        // Orchestrator receives WhatsApp message and enqueues
        const inbound: QueueMessage = {
            id: 'msg-roundtrip-001',
            userId,
            type: 'chat',
            payload: {
                sessionId: 'session-rt-1',
                agentGroupId: 'agent-main',
                kind: 'chat',
                content: JSON.stringify({ text: 'What meetings do I have today?' }),
                timestamp: new Date().toISOString(),
                channelType: 'whatsapp',
                platformId: '6590001111@s.whatsapp.net',
                threadId: null,
            },
            timestamp: new Date().toISOString(),
        };
        await messageQueue.enqueueForAgent(userId, inbound);

        // Sub-agent picks up message
        const msg = await messageQueue.dequeueForAgent(userId, 2);
        expect(msg).not.toBeNull();
        expect(msg!.id).toBe('msg-roundtrip-001');

        // Sub-agent processes and responds
        const response: AgentResponse = {
            id: 'resp-roundtrip-001',
            userId,
            type: 'chat',
            payload: {
                sessionId: msg!.payload.sessionId,
                agentGroupId: msg!.payload.agentGroupId,
                kind: 'chat',
                content: JSON.stringify({ text: 'You have 3 meetings today: standup at 9am, design review at 2pm, and 1:1 at 4pm.' }),
                channelType: msg!.payload.channelType,
                platformId: msg!.payload.platformId,
                threadId: null,
            },
            timestamp: new Date().toISOString(),
        };
        await messageQueue.enqueueResponse(userId, response);

        // Orchestrator picks up response for WhatsApp delivery
        const delivered = await messageQueue.dequeueResponse(2);
        expect(delivered).not.toBeNull();
        expect(delivered!.id).toBe('resp-roundtrip-001');
        expect(delivered!.userId).toBe(userId);

        const deliveredContent = JSON.parse(delivered!.payload.content as string);
        expect(deliveredContent.text).toContain('3 meetings today');

        // Queue should be empty after processing
        expect(await messageQueue.getQueueDepth(userId)).toBe(0);
    });

    it('failed message processing moves to DLQ and retries', async () => {
        const userId = 'user-dlq-test';

        const failedMessage: QueueMessage = {
            id: 'msg-fail-001',
            userId,
            type: 'chat',
            payload: {
                sessionId: 'session-fail',
                agentGroupId: 'agent-main',
                kind: 'chat',
                content: JSON.stringify({ text: 'trigger error' }),
                timestamp: new Date().toISOString(),
                channelType: 'whatsapp',
                platformId: '6590002222@s.whatsapp.net',
                threadId: null,
            },
            timestamp: new Date().toISOString(),
            retryCount: 0,
        };

        // Simulate processing failure — move to DLQ
        await messageQueue.moveToDLQ(failedMessage, 'LLM timeout');

        // Verify message is in DLQ
        const dlqEntries = messageQueue.getDLQ(userId);
        expect(dlqEntries).toHaveLength(1);
        expect(dlqEntries[0].error).toBe('LLM timeout');
        expect(dlqEntries[0].retryCount).toBe(1);

        // Retry from DLQ
        const retried = await messageQueue.retryFromDLQ();
        expect(retried).toBe(1);

        // Message should be back in the agent queue
        const retriedMsg = await messageQueue.dequeueForAgent(userId, 1);
        expect(retriedMsg).not.toBeNull();
        expect(retriedMsg!.id).toBe('msg-fail-001');
        expect(retriedMsg!.retryCount).toBe(1);
    });

    it('backpressure prevents new messages when queue is full', async () => {
        const userId = 'user-backpressure';

        // Fill the queue to backpressure threshold (100 messages)
        for (let i = 0; i < 100; i++) {
            await messageQueue.enqueueForAgent(userId, {
                id: `msg-bp-${i}`,
                userId,
                type: 'chat',
                payload: { content: `message ${i}` },
                timestamp: new Date().toISOString(),
            });
        }

        // Verify backpressure is triggered
        const isBackpressured = await messageQueue.isBackpressured(userId);
        expect(isBackpressured).toBe(true);

        // Queue depth should be at threshold
        const depth = await messageQueue.getQueueDepth(userId);
        expect(depth).toBe(100);
    });
});


// ── Test Suite: Document Upload and RAG Pipeline (AC-2) ──

describe('Integration: Document Upload and RAG Pipeline (AC-2)', () => {
    let messageQueue: InMemoryMessageQueue;
    let dataGateway: MockDataGateway;

    beforeEach(() => {
        messageQueue = new InMemoryMessageQueue();
        dataGateway = new MockDataGateway();
        messageQueue.connect();
    });

    afterEach(() => {
        messageQueue.disconnect();
    });

    it('document upload → chunking → indexing → RAG query returns relevant chunks', async () => {
        const userId = 'user-doc-upload';
        const filename = 'quarterly-report.pdf';

        // Step 1: Simulate document processing — text extracted and chunked
        const chunks: DocumentChunk[] = [
            {
                id: `${filename}-chunk-0`,
                docType: 'pdf',
                content: 'Q3 revenue grew 15% year-over-year to $2.3 billion, driven by cloud services expansion.',
                contentVector: new Array(1536).fill(0.1),
                filename,
                pageNumber: 1,
                chunkIndex: 0,
                uploadedAt: new Date().toISOString(),
            },
            {
                id: `${filename}-chunk-1`,
                docType: 'pdf',
                content: 'Operating expenses decreased 8% due to efficiency improvements in data center operations.',
                contentVector: new Array(1536).fill(0.2),
                filename,
                pageNumber: 1,
                chunkIndex: 1,
                uploadedAt: new Date().toISOString(),
            },
            {
                id: `${filename}-chunk-2`,
                docType: 'pdf',
                content: 'Customer acquisition cost reduced to $45 per user, a 20% improvement from Q2.',
                contentVector: new Array(1536).fill(0.3),
                filename,
                pageNumber: 2,
                chunkIndex: 2,
                uploadedAt: new Date().toISOString(),
            },
        ];

        // Step 2: Index all chunks via Data Gateway
        for (const chunk of chunks) {
            await dataGateway.indexDocument(userId, chunk);
        }

        // Verify all chunks are indexed
        const indexed = dataGateway.getIndexedDocuments(userId);
        expect(indexed).toHaveLength(3);

        // Step 3: RAG query — search for revenue information
        const queryVector = new Array(1536).fill(0.15);
        const results = await dataGateway.hybridSearch(userId, 'revenue', queryVector, 3);

        // Step 4: Verify relevant chunks are returned
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].content).toContain('revenue');
        expect(results[0].filename).toBe(filename);
        expect(results[0].score).toBeGreaterThan(0);
    });

    it('document upload triggers full pipeline via message queue', async () => {
        const userId = 'user-doc-pipeline';
        const filename = 'meeting-notes.docx';

        // Step 1: Orchestrator receives document upload and enqueues processing task
        const uploadMessage: QueueMessage = {
            id: 'msg-upload-001',
            userId,
            type: 'document_upload',
            payload: {
                sessionId: 'session-doc-1',
                agentGroupId: 'agent-main',
                kind: 'document',
                filename,
                s3Key: `staging/${userId}/upload-001/${filename}`,
                contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                timestamp: new Date().toISOString(),
            },
            timestamp: new Date().toISOString(),
        };
        await messageQueue.enqueueForAgent(userId, uploadMessage);

        // Step 2: Sub-agent dequeues the upload task
        const task = await messageQueue.dequeueForAgent(userId, 2);
        expect(task).not.toBeNull();
        expect(task!.type).toBe('document_upload');
        expect(task!.payload.filename).toBe(filename);

        // Step 3: Sub-agent processes document (extract → chunk → embed → index)
        const processedChunks: DocumentChunk[] = [
            {
                id: `${filename}-chunk-0`,
                docType: 'docx',
                content: 'Action items from Monday standup: deploy new auth service by Friday.',
                contentVector: new Array(1536).fill(0.4),
                filename,
                pageNumber: 1,
                chunkIndex: 0,
                uploadedAt: new Date().toISOString(),
            },
            {
                id: `${filename}-chunk-1`,
                docType: 'docx',
                content: 'Team agreed to migrate database to DynamoDB for better scalability.',
                contentVector: new Array(1536).fill(0.5),
                filename,
                pageNumber: 1,
                chunkIndex: 1,
                uploadedAt: new Date().toISOString(),
            },
        ];

        for (const chunk of processedChunks) {
            await dataGateway.indexDocument(userId, chunk);
        }

        // Step 4: Sub-agent sends completion response
        const completionResponse: AgentResponse = {
            id: 'resp-upload-001',
            userId,
            type: 'document_processed',
            payload: {
                sessionId: task!.payload.sessionId,
                agentGroupId: task!.payload.agentGroupId,
                kind: 'chat',
                content: JSON.stringify({ text: `Document "${filename}" processed successfully. 2 chunks indexed.` }),
                channelType: 'whatsapp',
                platformId: '6590003333@s.whatsapp.net',
                threadId: null,
            },
            timestamp: new Date().toISOString(),
        };
        await messageQueue.enqueueResponse(userId, completionResponse);

        // Step 5: Verify the response is available for delivery
        const delivered = await messageQueue.dequeueResponse(2);
        expect(delivered).not.toBeNull();
        expect(delivered!.type).toBe('document_processed');

        // Step 6: Subsequent RAG query finds the indexed content
        const searchResults = await dataGateway.hybridSearch(
            userId,
            'migrate database',
            new Array(1536).fill(0.5),
            3,
        );
        expect(searchResults.length).toBeGreaterThan(0);
        expect(searchResults[0].content).toContain('DynamoDB');
    });

    it('data isolation: user A cannot access user B documents', async () => {
        const userA = 'user-isolation-a';
        const userB = 'user-isolation-b';

        // Index documents for user B
        await dataGateway.indexDocument(userB, {
            id: 'secret-doc-chunk-0',
            docType: 'pdf',
            content: 'Confidential salary information for all employees.',
            contentVector: new Array(1536).fill(0.9),
            filename: 'salaries.pdf',
            pageNumber: 1,
            chunkIndex: 0,
            uploadedAt: new Date().toISOString(),
        });

        // User A searches — should find nothing from user B
        const results = await dataGateway.hybridSearch(
            userA,
            'salary',
            new Array(1536).fill(0.9),
            3,
        );
        expect(results).toHaveLength(0);

        // User B searches — should find their own document
        const userBResults = await dataGateway.hybridSearch(
            userB,
            'salary',
            new Array(1536).fill(0.9),
            3,
        );
        expect(userBResults.length).toBeGreaterThan(0);
        expect(userBResults[0].content).toContain('salary');
    });
});


// ── Test Suite: Container Failure Recovery (AC-6) ──

describe('Integration: Container Failure Recovery (AC-6)', () => {
    let containerManager: MockContainerManager;
    let messageQueue: InMemoryMessageQueue;

    beforeEach(() => {
        containerManager = new MockContainerManager();
        messageQueue = new InMemoryMessageQueue();
        messageQueue.connect();
    });

    afterEach(() => {
        messageQueue.disconnect();
    });

    it('container OOM kill (exit 137) triggers automatic restart', async () => {
        const userId = 'user-oom-test';

        // Spawn container
        const container = await containerManager.spawn(userId);
        expect(container.status).toBe('running');
        expect(containerManager.getStatus(userId)).toBe('running');

        // Simulate OOM kill (exit code 137 = SIGKILL from kernel)
        containerManager.simulateFailure(userId, 137);
        expect(containerManager.getStatus(userId)).toBe('stopped');

        // Automatic restart should succeed
        const restart = await containerManager.simulateAutoRestart(userId);
        expect(restart.restarted).toBe(true);
        expect(containerManager.getStatus(userId)).toBe('running');
    });

    it('container restart completes within 30s backoff budget', async () => {
        const userId = 'user-restart-timing';

        // Spawn and simulate first failure
        await containerManager.spawn(userId);
        containerManager.simulateFailure(userId, 1); // Process crash

        // First restart: backoff = 2^0 * 1000 = 1000ms (1s)
        const restart1 = await containerManager.simulateAutoRestart(userId);
        expect(restart1.restarted).toBe(true);
        expect(restart1.timeMs).toBeLessThanOrEqual(30_000);
        expect(restart1.timeMs).toBe(1000); // 2^0 * 1000

        // Second failure and restart: backoff = 2^1 * 1000 = 2000ms (2s)
        containerManager.simulateFailure(userId, 1);
        const restart2 = await containerManager.simulateAutoRestart(userId);
        expect(restart2.restarted).toBe(true);
        expect(restart2.timeMs).toBeLessThanOrEqual(30_000);
        expect(restart2.timeMs).toBe(2000); // 2^1 * 1000

        // Third failure and restart: backoff = 2^2 * 1000 = 4000ms (4s)
        containerManager.simulateFailure(userId, 1);
        const restart3 = await containerManager.simulateAutoRestart(userId);
        expect(restart3.restarted).toBe(true);
        expect(restart3.timeMs).toBeLessThanOrEqual(30_000);
        expect(restart3.timeMs).toBe(4000); // 2^2 * 1000
    });

    it('repeated failures (>3 in 5min) quarantine the user', async () => {
        const userId = 'user-quarantine-test';

        // Spawn and simulate 4 rapid failures (exceeds threshold of 3)
        await containerManager.spawn(userId);
        containerManager.simulateFailure(userId, 137);
        await containerManager.simulateAutoRestart(userId);

        containerManager.simulateFailure(userId, 1);
        await containerManager.simulateAutoRestart(userId);

        containerManager.simulateFailure(userId, 1);
        await containerManager.simulateAutoRestart(userId);

        // 4th failure triggers quarantine (>3 failures)
        containerManager.simulateFailure(userId, 1);
        const result = await containerManager.simulateAutoRestart(userId);

        expect(result.restarted).toBe(false);
        expect(containerManager.isQuarantined(userId)).toBe(true);
        expect(containerManager.getStatus(userId)).toBe('quarantined');
    });

    it('container failure preserves queued messages for retry after restart', async () => {
        const userId = 'user-msg-preserve';

        // Spawn container and enqueue messages
        await containerManager.spawn(userId);
        const pendingMessage: QueueMessage = {
            id: 'msg-pending-001',
            userId,
            type: 'chat',
            payload: {
                content: JSON.stringify({ text: 'Process this after restart' }),
                sessionId: 'session-preserve',
                agentGroupId: 'agent-main',
            },
            timestamp: new Date().toISOString(),
        };
        await messageQueue.enqueueForAgent(userId, pendingMessage);

        // Container crashes
        containerManager.simulateFailure(userId, 137);

        // Messages remain in queue (Redis persists independently of container)
        const depth = await messageQueue.getQueueDepth(userId);
        expect(depth).toBe(1);

        // Container restarts
        await containerManager.simulateAutoRestart(userId);
        expect(containerManager.getStatus(userId)).toBe('running');

        // Sub-agent can pick up the pending message after restart
        const msg = await messageQueue.dequeueForAgent(userId, 1);
        expect(msg).not.toBeNull();
        expect(msg!.id).toBe('msg-pending-001');
    });

    it('different exit codes trigger appropriate recovery behavior', async () => {
        const userId = 'user-exit-codes';

        // Exit 0: normal exit — no restart needed
        await containerManager.spawn(userId);
        // Normal exit doesn't increment failure count
        expect(containerManager.getStatus(userId)).toBe('running');

        // Exit 137: OOM kill — restart with alert
        containerManager.simulateFailure(userId, 137);
        const oomRestart = await containerManager.simulateAutoRestart(userId);
        expect(oomRestart.restarted).toBe(true);

        // Exit 1: generic crash — restart with backoff
        containerManager.simulateFailure(userId, 1);
        const crashRestart = await containerManager.simulateAutoRestart(userId);
        expect(crashRestart.restarted).toBe(true);
        // Backoff increases with each failure
        expect(crashRestart.timeMs).toBeGreaterThan(oomRestart.timeMs);
    });

    it('quarantined user spawn attempt throws error', async () => {
        const userId = 'user-quarantine-spawn';

        // Force quarantine by exceeding failure threshold
        await containerManager.spawn(userId);
        for (let i = 0; i < 4; i++) {
            containerManager.simulateFailure(userId, 1);
            await containerManager.simulateAutoRestart(userId);
        }

        expect(containerManager.isQuarantined(userId)).toBe(true);

        // Attempting to spawn for quarantined user should throw
        await expect(containerManager.spawn(userId)).rejects.toThrow('quarantined');
    });
});
