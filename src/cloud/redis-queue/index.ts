/**
 * Redis Message Queue — async message passing between orchestrator and sub-agents
 * using ElastiCache Redis Lists (LPUSH/BRPOP).
 *
 * Key patterns:
 *   queue:agent:{userId}:inbound    — Orchestrator → Sub-Agent messages
 *   queue:orchestrator:responses     — Sub-Agent → Orchestrator responses
 *   queue:dlq:{userId}              — Dead letter queue per user
 *
 * Requirements: REQ-4.2
 */

import Redis from 'ioredis';

import type {
    AgentResponse,
    DLQEntry,
    IMessageQueue,
    QueueMessage,
    RedisQueueConfig,
} from './types.js';

export type { IMessageQueue, QueueMessage, AgentResponse, DLQEntry, RedisQueueConfig } from './types.js';

/** Maximum retry count before a DLQ message is considered permanently failed. */
const MAX_DLQ_RETRIES = 3;

/** Backpressure threshold: reject new messages when queue depth exceeds this. */
const BACKPRESSURE_THRESHOLD = 100;

export class MessageQueue implements IMessageQueue {
    private redis: Redis | null = null;
    private blockingRedis: Redis | null = null;
    private readonly config: RedisQueueConfig;

    constructor(config: RedisQueueConfig) {
        this.config = config;
    }

    // ── Lifecycle ──

    async connect(): Promise<void> {
        const opts = {
            host: this.config.host,
            port: this.config.port,
            password: this.config.password,
            tls: this.config.tls ? {} : undefined,
            lazyConnect: true,
            maxRetriesPerRequest: 3,
        };

        this.redis = new Redis(opts);
        // Separate connection for blocking operations (BRPOP blocks the connection)
        this.blockingRedis = new Redis(opts);

        await this.redis.connect();
        await this.blockingRedis.connect();
    }

    async disconnect(): Promise<void> {
        if (this.redis) {
            await this.redis.quit();
            this.redis = null;
        }
        if (this.blockingRedis) {
            await this.blockingRedis.quit();
            this.blockingRedis = null;
        }
    }

    // ── Orchestrator → Sub-Agent ──

    async enqueueForAgent(userId: string, message: QueueMessage): Promise<void> {
        this.assertConnected();
        this.assertUserId(userId);

        const key = this.agentInboundKey(userId);
        const serialized = JSON.stringify(message);

        await this.redis!.lpush(key, serialized);
    }

    async dequeueForAgent(userId: string, timeout: number): Promise<QueueMessage | null> {
        this.assertConnected();
        this.assertUserId(userId);

        const key = this.agentInboundKey(userId);
        const result = await this.blockingRedis!.brpop(key, timeout);

        if (!result) {
            return null;
        }

        // BRPOP returns [key, value]
        const [, value] = result;
        return JSON.parse(value) as QueueMessage;
    }

    // ── Sub-Agent → Orchestrator ──

    async enqueueResponse(userId: string, response: AgentResponse): Promise<void> {
        this.assertConnected();
        this.assertUserId(userId);

        const key = this.orchestratorResponseKey();
        const serialized = JSON.stringify(response);

        await this.redis!.lpush(key, serialized);
    }

    async dequeueResponse(timeout: number): Promise<AgentResponse | null> {
        this.assertConnected();

        const key = this.orchestratorResponseKey();
        const result = await this.blockingRedis!.brpop(key, timeout);

        if (!result) {
            return null;
        }

        const [, value] = result;
        return JSON.parse(value) as AgentResponse;
    }

    // ── Dead Letter Queue ──

    async moveToDLQ(message: QueueMessage, error: string): Promise<void> {
        this.assertConnected();
        this.assertUserId(message.userId);

        const key = this.dlqKey(message.userId);
        const entry: DLQEntry = {
            message,
            error,
            movedAt: new Date().toISOString(),
            retryCount: (message.retryCount ?? 0) + 1,
        };

        await this.redis!.lpush(key, JSON.stringify(entry));
    }

    async retryFromDLQ(): Promise<number> {
        this.assertConnected();

        // Scan all DLQ keys and retry eligible messages
        let retriedCount = 0;
        const pattern = this.keyWithPrefix('queue:dlq:*');
        let cursor = '0';

        do {
            const [nextCursor, keys] = await this.redis!.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = nextCursor;

            for (const dlqKey of keys) {
                retriedCount += await this.retryDLQForKey(dlqKey);
            }
        } while (cursor !== '0');

        return retriedCount;
    }

    // ── Backpressure ──

    async getQueueDepth(userId: string): Promise<number> {
        this.assertConnected();
        this.assertUserId(userId);

        const key = this.agentInboundKey(userId);
        return this.redis!.llen(key);
    }

    async isBackpressured(userId: string): Promise<boolean> {
        const depth = await this.getQueueDepth(userId);
        return depth >= BACKPRESSURE_THRESHOLD;
    }

    // ── Private helpers ──

    private async retryDLQForKey(dlqKey: string): Promise<number> {
        let retriedCount = 0;
        const queueLength = await this.redis!.llen(dlqKey);

        // Process all entries in the DLQ for this key
        for (let i = 0; i < queueLength; i++) {
            const raw = await this.redis!.rpop(dlqKey);
            if (!raw) break;

            const entry = JSON.parse(raw) as DLQEntry;

            // Skip messages that have exceeded max retries
            if (entry.retryCount >= MAX_DLQ_RETRIES) {
                // Put it back — it's permanently failed, leave in DLQ
                await this.redis!.lpush(dlqKey, raw);
                continue;
            }

            // Re-enqueue to the agent's inbound queue with incremented retry count
            const message: QueueMessage = {
                ...entry.message,
                retryCount: entry.retryCount,
            };

            const inboundKey = this.agentInboundKey(message.userId);
            await this.redis!.lpush(inboundKey, JSON.stringify(message));
            retriedCount++;
        }

        return retriedCount;
    }

    private agentInboundKey(userId: string): string {
        return this.keyWithPrefix(`queue:agent:${userId}:inbound`);
    }

    private orchestratorResponseKey(): string {
        return this.keyWithPrefix('queue:orchestrator:responses');
    }

    private dlqKey(userId: string): string {
        return this.keyWithPrefix(`queue:dlq:${userId}`);
    }

    private keyWithPrefix(key: string): string {
        if (this.config.keyPrefix) {
            return `${this.config.keyPrefix}:${key}`;
        }
        return key;
    }

    private assertConnected(): void {
        if (!this.redis || !this.blockingRedis) {
            throw new Error('MessageQueue: not connected. Call connect() first.');
        }
    }

    private assertUserId(userId: string): void {
        if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
            throw new Error('MessageQueue: userId is required for all operations (data isolation enforcement)');
        }
    }
}
