/**
 * Cloud Bootstrap — initializes all cloud services in the correct order
 * when running in cloud mode (NANOCLAW_ENV=cloud).
 *
 * Initialization order:
 *   1. Secrets Manager config (all other services depend on credentials)
 *   2. Data Gateway (DynamoDB, OpenSearch, S3)
 *   3. Redis message queue
 *   4. Rate limiter (depends on Redis)
 *   5. CloudWatch logger
 *   6. Health check aggregator
 *   7. Scheduler service
 *
 * Exports a singleton `cloudServices` object that holds references to all
 * initialized services. Components check `isCloudMode()` before accessing
 * cloud services.
 *
 * Requirements: REQ-4.1, REQ-4.2, REQ-4.3, REQ-9.1
 */

import { Redis } from 'ioredis';

import { log } from '../log.js';

import { DataGateway } from './data-gateway/index.js';
import { HealthCheckAggregator } from './health/index.js';
import { CloudWatchLogger } from './logging/index.js';
import { RateLimiter } from './rate-limiter/index.js';
import { MessageQueue } from './redis-queue/index.js';
import { SchedulerService } from './scheduler/index.js';
import { SecretsLoader } from './secrets/index.js';

import type { NanoClawCloudConfig } from './secrets/index.js';
import type { IMessageQueue, AgentResponse } from './redis-queue/index.js';

// ioredis named export — Redis is the class directly
type RedisClient = Redis;

// ── Environment detection ──

/**
 * Returns true when the orchestrator is running in cloud mode.
 * Cloud mode is activated by setting NANOCLAW_ENV=cloud.
 */
export function isCloudMode(): boolean {
    return process.env.NANOCLAW_ENV === 'cloud';
}

// ── Cloud services singleton ──

export interface CloudServices {
    config: NanoClawCloudConfig;
    secretsLoader: SecretsLoader;
    dataGateway: DataGateway;
    messageQueue: IMessageQueue;
    rateLimiter: RateLimiter;
    logger: CloudWatchLogger;
    healthCheck: HealthCheckAggregator;
    scheduler: SchedulerService;
    redis: RedisClient;
}

let _services: CloudServices | null = null;

/**
 * Get the initialized cloud services. Returns null if not in cloud mode
 * or if bootstrap hasn't completed yet.
 */
export function getCloudServices(): CloudServices | null {
    return _services;
}

// ── Response poll state ──

let responsePollRunning = false;
let responsePollTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Bootstrap all cloud services. Called from src/index.ts when NANOCLAW_ENV=cloud.
 *
 * Initialization is sequential to respect dependency ordering.
 * Failures in non-critical services (scheduler, health) are logged but don't
 * prevent startup — the orchestrator degrades gracefully.
 */
export async function bootstrapCloudServices(): Promise<CloudServices> {
    log.info('Cloud bootstrap: starting initialization');

    // 1. Secrets Manager config
    log.info('Cloud bootstrap: loading secrets');
    const secretsLoader = new SecretsLoader();
    const config = await secretsLoader.loadConfig();
    secretsLoader.startAutoRefresh();
    log.info('Cloud bootstrap: secrets loaded');

    // 2. Data Gateway
    log.info('Cloud bootstrap: initializing Data Gateway');
    const dataGateway = DataGateway.createWithConfig({
        region: 'ap-southeast-1',
        dynamoDb: config.dynamoDb,
        openSearch: config.openSearch,
        s3: config.s3,
    });
    log.info('Cloud bootstrap: Data Gateway ready');

    // 3. Redis connection (shared between queue and rate limiter)
    log.info('Cloud bootstrap: connecting to Redis');
    const redis = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        tls: config.redis.tls ? {} : undefined,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
    });
    await redis.connect();
    log.info('Cloud bootstrap: Redis connected');

    // 4. Message queue
    log.info('Cloud bootstrap: initializing message queue');
    const messageQueue = new MessageQueue({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        tls: config.redis.tls,
    });
    await messageQueue.connect();
    log.info('Cloud bootstrap: message queue ready');

    // 5. Rate limiter
    log.info('Cloud bootstrap: initializing rate limiter');
    const rateLimiter = new RateLimiter(redis);
    log.info('Cloud bootstrap: rate limiter ready');

    // 6. CloudWatch logger
    log.info('Cloud bootstrap: initializing CloudWatch logger');
    const logger = new CloudWatchLogger({ region: 'ap-southeast-1' });
    log.info('Cloud bootstrap: CloudWatch logger ready');

    // 7. Health check aggregator (non-critical — graceful degradation)
    let healthCheck: HealthCheckAggregator;
    try {
        log.info('Cloud bootstrap: initializing health check aggregator');
        healthCheck = new HealthCheckAggregator({
            checkRedis: async () => {
                const pong = await redis.ping();
                return pong === 'PONG';
            },
            checkDynamoDB: async () => {
                // Simple connectivity check — DataGateway handles actual operations
                return dataGateway.isInitialized;
            },
            checkOpenSearch: async () => {
                return dataGateway.isInitialized;
            },
            checkWhatsAppSession: async () => ({
                valid: true,
                lastChecked: new Date().toISOString(),
                message: 'Session check delegated to channel adapter',
            }),
            getActiveContainerCount: () => 0, // Updated by container manager
            getQuarantinedCount: () => 0,
            sendAdminAlert: async (message, severity) => {
                log.warn(`Admin alert [${severity}]: ${message}`);
            },
        });
        healthCheck.start();
        log.info('Cloud bootstrap: health check aggregator started');
    } catch (err) {
        log.error('Cloud bootstrap: health check aggregator failed (non-critical)', { err });
        // Create a minimal stub so the rest of the system works
        healthCheck = new HealthCheckAggregator({
            checkRedis: async () => false,
            checkDynamoDB: async () => false,
            checkOpenSearch: async () => false,
            checkWhatsAppSession: async () => ({ valid: false, lastChecked: new Date().toISOString() }),
            getActiveContainerCount: () => 0,
            getQuarantinedCount: () => 0,
            sendAdminAlert: async () => { /* no-op */ },
        });
    }

    // 8. Scheduler service (non-critical — graceful degradation)
    let scheduler: SchedulerService;
    try {
        log.info('Cloud bootstrap: initializing scheduler');
        scheduler = new SchedulerService({
            dataGateway,
            messageQueue,
            getActiveUserIds: async () => {
                // In production, this would query DynamoDB for active users.
                // For now, return empty — the scheduler will be wired to the
                // container manager's active user list.
                return [];
            },
        });
        scheduler.start();
        log.info('Cloud bootstrap: scheduler started');
    } catch (err) {
        log.error('Cloud bootstrap: scheduler failed (non-critical)', { err });
        scheduler = new SchedulerService({
            dataGateway,
            messageQueue,
            getActiveUserIds: async () => [],
        });
    }

    _services = {
        config,
        secretsLoader,
        dataGateway,
        messageQueue,
        rateLimiter,
        logger,
        healthCheck,
        scheduler,
        redis,
    };

    log.info('Cloud bootstrap: all services initialized');

    // Start the upload worker (processes admin dashboard uploads → sub-agent queues)
    try {
        const { startUploadWorker } = await import('./upload-worker/index.js');
        startUploadWorker(_services);
        log.info('Cloud bootstrap: upload worker started');
    } catch (err) {
        log.error('Cloud bootstrap: upload worker failed (non-critical)', { err });
    }

    return _services;
}

/**
 * Start polling the Redis response queue for sub-agent responses.
 * Dequeues responses and invokes the provided callback for delivery.
 *
 * This replaces the SQLite outbound.db polling in cloud mode.
 */
export function startResponsePoll(
    onResponse: (response: AgentResponse) => Promise<void>,
): void {
    if (responsePollRunning) return;
    if (!_services) {
        log.warn('Cannot start response poll — cloud services not initialized');
        return;
    }

    responsePollRunning = true;
    pollResponses(onResponse);
    log.info('Cloud response poll started');
}

async function pollResponses(
    onResponse: (response: AgentResponse) => Promise<void>,
): Promise<void> {
    if (!responsePollRunning || !_services) return;

    try {
        // Use a short timeout (2s) so we can check the running flag frequently
        const response = await _services.messageQueue.dequeueResponse(2);
        if (response) {
            try {
                await onResponse(response);
            } catch (err) {
                log.error('Failed to handle agent response', {
                    responseId: response.id,
                    userId: response.userId,
                    err,
                });
            }
        }
    } catch (err) {
        log.error('Response poll error', { err });
        // Brief pause on error to avoid tight error loops
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Schedule next poll iteration (non-blocking)
    responsePollTimer = setTimeout(() => pollResponses(onResponse), 0);
}

/**
 * Stop the response poll loop.
 */
export function stopResponsePoll(): void {
    responsePollRunning = false;
    if (responsePollTimer) {
        clearTimeout(responsePollTimer);
        responsePollTimer = null;
    }
}

/**
 * Graceful shutdown of all cloud services.
 */
export async function shutdownCloudServices(): Promise<void> {
    if (!_services) return;

    log.info('Cloud shutdown: stopping services');

    stopResponsePoll();

    // Stop upload worker
    try {
        const { stopUploadWorker } = await import('./upload-worker/index.js');
        stopUploadWorker();
    } catch { /* upload worker may not have been started */ }

    _services.scheduler.stop();
    _services.healthCheck.stop();
    _services.secretsLoader.stopAutoRefresh();

    try {
        await _services.messageQueue.disconnect();
    } catch (err) {
        log.error('Cloud shutdown: message queue disconnect failed', { err });
    }

    try {
        await _services.redis.quit();
    } catch (err) {
        log.error('Cloud shutdown: Redis disconnect failed', { err });
    }

    _services = null;
    log.info('Cloud shutdown: complete');
}
