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

import { Redis } from 'ioredis';

import {
    agentInboundKey as sharedAgentInboundKey,
    orchestratorResponseKey as sharedOrchestratorResponseKey,
    dlqKey as sharedDlqKey,
} from '../redis-keys.js';

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

/**
 * TODO (improvement #14): Replace Redis Lists (LPUSH/BRPOP) with Redis Streams
 * (XADD/XREADGROUP/XACK) for at-least-once delivery semantics.
 *
 * Current risk: if a sub-agent task is killed between BRPOP (message removed from
 * queue) and LPUSH to response queue (message not yet processed), the message is
 * permanently lost — it is not in the queue and not in the DLQ.
 *
 * Redis Streams give consumer group semantics: unacknowledged messages remain in
 * the Pending Entries List (PEL) and can be re-delivered on XAUTOCLAIM after a
 * visibility timeout (e.g. 5 minutes). The consumer calls XACK only after
 * successfully pushing the response.
 */

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

    // ── Redis Streams (at-least-once) — additive, flag-gated (t2-8) ──
    //
    // When REDIS_STREAMS_ENABLED=true, callers may use these XADD/XREADGROUP/
    // XACK methods instead of LPUSH/BRPOP. Messages are only removed from the
    // pending entries list (PEL) after an explicit ack, so a worker crash mid-
    // processing leaves the message claimable by another consumer rather than
    // lost. The list-based methods above are left fully intact so flipping the
    // flag off restores the exact previous behavior (non-breaking).

    /** Whether Streams mode is enabled (env-gated, default off). */
    get streamsEnabled(): boolean {
        return (process.env.REDIS_STREAMS_ENABLED ?? 'false') === 'true';
    }

    private streamKey(userId: string): string {
        // Distinct keyspace from the list keys so the two transports never
        // collide; a list key and a stream key cannot share a name in Redis.
        return this.keyWithPrefix(
            userId === 'dispatch'
                ? 'stream:agent:dispatch'
                : `stream:agent:${userId}:inbound`,
        );
    }

    /** XADD a message onto the agent inbound stream. Returns the stream id. */
    async enqueueForAgentStream(userId: string, message: QueueMessage): Promise<string> {
        this.assertConnected();
        this.assertUserId(userId);
        const key = this.streamKey(userId);
        // MAXLEN ~ caps unbounded growth; '~' = approximate trim (cheap).
        const id = await this.redis!.xadd(
            key,
            'MAXLEN',
            '~',
            10000,
            '*',
            'data',
            JSON.stringify(message),
        );
        return id ?? '';
    }

    /**
     * Read + claim one message via a consumer group (at-least-once). Creates
     * the group lazily. Returns { id, message } so the caller can XACK after
     * successful processing. Returns null on timeout.
     */
    async dequeueForAgentStream(
        userId: string,
        group: string,
        consumer: string,
        blockMs: number,
    ): Promise<{ id: string; message: QueueMessage } | null> {
        this.assertConnected();
        this.assertUserId(userId);
        const key = this.streamKey(userId);
        await this.ensureGroup(key, group);
        // '>' = only new, never-delivered messages for this group.
        const res = (await this.blockingRedis!.xreadgroup(
            'GROUP',
            group,
            consumer,
            'COUNT',
            1,
            'BLOCK',
            blockMs,
            'STREAMS',
            key,
            '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;
        if (!res || res.length === 0) return null;
        const entries = res[0][1];
        if (!entries || entries.length === 0) return null;
        const [id, fields] = entries[0];
        // fields = ['data', '<json>']
        const dataIdx = fields.indexOf('data');
        if (dataIdx < 0) return null;
        return { id, message: JSON.parse(fields[dataIdx + 1]) as QueueMessage };
    }

    /** Acknowledge a processed stream message, removing it from the PEL. */
    async ackForAgentStream(userId: string, group: string, id: string): Promise<void> {
        this.assertConnected();
        this.assertUserId(userId);
        const key = this.streamKey(userId);
        await this.redis!.xack(key, group, id);
    }

    /** Idempotently create a consumer group at the stream head (MKSTREAM). */
    private async ensureGroup(key: string, group: string): Promise<void> {
        try {
            await this.redis!.xgroup('CREATE', key, group, '$', 'MKSTREAM');
        } catch (err) {
            // BUSYGROUP = already exists; any other error is real.
            if (!String((err as Error).message).includes('BUSYGROUP')) {
                throw err;
            }
        }
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
        const pattern = this.keyWithPrefix('queue:agent:*:dlq');
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

    /**
     * B3 (Wave 6): list DLQ entries across users for admin inspection.
     * Returns all DLQ entries in (userId -> entries[]) form. Capped at
     * `limit` per user so a runaway user can't blow up the response.
     */
    async listDLQ(limit = 25): Promise<Record<string, DLQEntry[]>> {
        this.assertConnected();
        const out: Record<string, DLQEntry[]> = {};
        const pattern = this.keyWithPrefix('queue:agent:*:dlq');
        let cursor = '0';
        do {
            const [nextCursor, keys] = await this.redis!.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = nextCursor;
            for (const dlqKey of keys) {
                const parts = dlqKey.split(':'); const userId = parts[parts.length - 2] ?? 'unknown';
                const raws = await this.redis!.lrange(dlqKey, 0, limit - 1);
                out[userId] = raws.map(raw => JSON.parse(raw) as DLQEntry);
            }
        } while (cursor !== '0');
        return out;
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
        // Delegates to the shared namespace so the 'dispatch' sentinel maps to
        // the worker-pool queue (queue:agent:dispatch) that the ECS sub-agent
        // actually BRPOPs — fixing the prior queue:agent:dispatch:inbound
        // mismatch. See src/cloud/redis-keys.ts (t4-25).
        return this.keyWithPrefix(sharedAgentInboundKey(userId));
    }

    private orchestratorResponseKey(): string {
        return this.keyWithPrefix(sharedOrchestratorResponseKey());
    }

    private dlqKey(userId: string): string {
        return this.keyWithPrefix(sharedDlqKey(userId));
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

