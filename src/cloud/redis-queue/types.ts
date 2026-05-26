/**
 * Redis Message Queue types — interfaces for async message passing
 * between the orchestrator and sub-agent containers via ElastiCache Redis.
 *
 * Requirements: REQ-4.2
 */

// ── Queue message types ──

export interface QueueMessage {
    id: string;
    userId: string;
    type: string;
    payload: Record<string, unknown>;
    timestamp: string; // ISO 8601
    retryCount?: number;
}

export interface AgentResponse {
    id: string;
    userId: string;
    type: string;
    payload: Record<string, unknown>;
    timestamp: string; // ISO 8601
}

export interface DLQEntry {
    message: QueueMessage;
    error: string;
    movedAt: string; // ISO 8601
    retryCount: number;
}

// ── Configuration ──

export interface RedisQueueConfig {
    host: string;
    port: number;
    password?: string;
    tls?: boolean;
    keyPrefix?: string;
}

// ── Interface ──

export interface IMessageQueue {
    // Lifecycle
    connect(): Promise<void>;
    disconnect(): Promise<void>;

    // Orchestrator → Sub-Agent
    enqueueForAgent(userId: string, message: QueueMessage): Promise<void>;
    dequeueForAgent(userId: string, timeout: number): Promise<QueueMessage | null>;

    // Sub-Agent → Orchestrator
    enqueueResponse(userId: string, response: AgentResponse): Promise<void>;
    dequeueResponse(timeout: number): Promise<AgentResponse | null>;

    // Dead letter queue
    moveToDLQ(message: QueueMessage, error: string): Promise<void>;
    retryFromDLQ(): Promise<number>;

    // Backpressure
    getQueueDepth(userId: string): Promise<number>;
    isBackpressured(userId: string): Promise<boolean>;
}
