/**
 * DataGateway Worker — consumes the `queue:orchestrator:data_gateway` Redis list
 * and executes persistence operations (index documents, validate tokens, list files, etc.)
 * on behalf of sub-agents.
 *
 * Sub-agents cannot access DynamoDB/OpenSearch/S3 directly (they only have Redis access).
 * They send structured requests to this queue, and this worker executes them via the
 * DataGateway (which enforces userId isolation on all operations).
 *
 * Supported actions:
 *   - index_document: index a chunk into OpenSearch
 *   - list_files: list user's files in S3
 *   - delete_file: delete a file from S3
 *   - delete_user_documents: delete indexed chunks from OpenSearch
 *   - get_file: download a file from S3
 *   - create_webhook_token: create a save confirmation token in DynamoDB
 *   - validate_webhook_token: validate and consume a token
 *   - get_user_preference: fetch user preferences from DynamoDB
 *
 * Requirements: REQ-7.1 (Data Gateway), REQ-2.1 (Data Isolation)
 */

import { log } from '../../log.js';

import type { CloudServices } from '../bootstrap.js';
import type { DocumentChunk } from '../data-gateway/types.js';

// ── Config ──

const QUEUE_KEY = 'queue:orchestrator:data_gateway';
const POLL_INTERVAL_MS = 1000;

// ── State ──

let running = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// ── Public API ──

export function startDataGatewayWorker(services: CloudServices): void {
    if (running) return;
    running = true;
    log.info('DataGateway worker started', { queueKey: QUEUE_KEY });
    void pollLoop(services);
}

export function stopDataGatewayWorker(): void {
    running = false;
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    log.info('DataGateway worker stopped');
}

// ── Internal ──

async function pollLoop(services: CloudServices): Promise<void> {
    if (!running) return;

    try {
        const processed = await processNextRequest(services);
        pollTimer = setTimeout(
            () => pollLoop(services),
            processed ? 0 : POLL_INTERVAL_MS,
        );
    } catch (err) {
        log.error('DataGateway worker poll error', { err });
        pollTimer = setTimeout(() => pollLoop(services), POLL_INTERVAL_MS * 2);
    }
}

async function processNextRequest(services: CloudServices): Promise<boolean> {
    const raw = await services.redis.rpop(QUEUE_KEY);
    if (!raw) return false;

    let request: Record<string, unknown>;
    try {
        request = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
        log.error('DataGateway worker: failed to parse request', { raw, err });
        return true;
    }

    const action = request.action as string;
    const userId = request.user_id as string;
    const requestId = request.request_id as string | undefined;

    if (!action) {
        log.warn('DataGateway worker: request missing action', { request });
        return true;
    }

    try {
        switch (action) {
            case 'index_document':
                await handleIndexDocument(services, userId, request);
                break;

            case 'list_files':
                await handleListFiles(services, userId, requestId, request);
                break;

            case 'delete_file':
                await handleDeleteFile(services, userId, request);
                break;

            case 'delete_user_documents':
                await handleDeleteUserDocuments(services, userId, request);
                break;

            case 'get_file':
                await handleGetFile(services, userId, requestId, request);
                break;

            case 'create_webhook_token':
                await handleCreateWebhookToken(services, userId, request);
                break;

            case 'validate_webhook_token':
                await handleValidateWebhookToken(services, userId, requestId, request);
                break;

            case 'get_user_preference':
                await handleGetUserPreference(services, userId, requestId);
                break;

            default:
                log.warn('DataGateway worker: unknown action', { action, userId });
        }
    } catch (err) {
        log.error('DataGateway worker: action failed', { action, userId, err });

        // Send error response if requestId is present
        if (requestId && userId) {
            const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
            await services.redis.lpush(responseKey, JSON.stringify({
                success: false,
                error: (err as Error).message,
            }));
            // Expire the response key after 60s to prevent Redis memory leak
            await services.redis.expire(responseKey, 60);
        }
    }

    return true;
}

// ── Action Handlers ──

async function handleIndexDocument(
    services: CloudServices,
    userId: string,
    request: Record<string, unknown>,
): Promise<void> {
    const chunk = request.chunk as DocumentChunk;
    if (!chunk || !userId) {
        log.warn('DataGateway worker: index_document missing chunk or userId');
        return;
    }

    await services.dataGateway.indexDocument(userId, chunk);
    log.debug('Indexed document chunk', { userId, chunkId: chunk.id, filename: chunk.filename });
}

async function handleListFiles(
    services: CloudServices,
    userId: string,
    requestId: string | undefined,
    request: Record<string, unknown>,
): Promise<void> {
    const prefix = (request.prefix as string) || '';
    const files = await services.dataGateway.listFiles(userId, prefix);

    if (requestId) {
        const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
        await services.redis.lpush(responseKey, JSON.stringify({ success: true, files }));
        await services.redis.expire(responseKey, 60);
    }
}

async function handleDeleteFile(
    services: CloudServices,
    userId: string,
    request: Record<string, unknown>,
): Promise<void> {
    const key = request.key as string;
    const bucket = (request.bucket as string) || '';
    if (!key) return;

    await services.dataGateway.deleteFile(userId, bucket, key);
    log.info('Deleted file', { userId, key });
}

async function handleDeleteUserDocuments(
    services: CloudServices,
    userId: string,
    request: Record<string, unknown>,
): Promise<void> {
    const filename = request.filename as string | undefined;
    await services.dataGateway.deleteUserDocuments(userId, filename);
    log.info('Deleted user documents from index', { userId, filename });
}

async function handleGetFile(
    services: CloudServices,
    userId: string,
    requestId: string | undefined,
    request: Record<string, unknown>,
): Promise<void> {
    const key = request.key as string;
    const bucket = (request.bucket as string) || '';
    if (!key || !requestId) return;

    try {
        const stream = await services.dataGateway.getFile(userId, bucket, key);
        // Read stream to buffer for Redis transport
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let done = false;
        while (!done) {
            const result = await reader.read();
            done = result.done;
            if (result.value) chunks.push(result.value);
        }
        const buffer = Buffer.concat(chunks);

        const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
        await services.redis.lpush(responseKey, JSON.stringify({
            success: true,
            content: buffer.toString('base64'),
            content_type: 'application/octet-stream',
        }));
        await services.redis.expire(responseKey, 60);
    } catch (err) {
        const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
        await services.redis.lpush(responseKey, JSON.stringify({
            success: false,
            error: (err as Error).message,
        }));
        await services.redis.expire(responseKey, 60);
    }
}

async function handleCreateWebhookToken(
    services: CloudServices,
    userId: string,
    request: Record<string, unknown>,
): Promise<void> {
    const tokenHash = request.token_hash as string;
    if (!tokenHash || !userId) return;

    await services.dataGateway.createWebhookToken(userId, tokenHash);
    log.debug('Created webhook token', { userId });
}

async function handleValidateWebhookToken(
    services: CloudServices,
    userId: string,
    requestId: string | undefined,
    request: Record<string, unknown>,
): Promise<void> {
    const tokenHash = request.token_hash as string;
    if (!tokenHash || !requestId) return;

    const result = await services.dataGateway.validateWebhookToken(tokenHash);

    const responseKey = `queue:agent:${userId}:token_response:${requestId}`;
    await services.redis.lpush(responseKey, JSON.stringify({ valid: result.valid }));
    await services.redis.expire(responseKey, 60);
}

async function handleGetUserPreference(
    services: CloudServices,
    userId: string,
    requestId: string | undefined,
): Promise<void> {
    if (!requestId || !userId) return;

    const prefs = await services.dataGateway.getUserPreference(userId);

    const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
    await services.redis.lpush(responseKey, JSON.stringify({
        success: true,
        preferences: prefs,
    }));
    await services.redis.expire(responseKey, 60);
}
