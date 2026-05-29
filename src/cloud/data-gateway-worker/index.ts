/* eslint-disable */
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
 *   - put_user_preference: merge and store user preferences in DynamoDB (validates persona enum fields)
 *
 * Requirements: REQ-7.1 (Data Gateway), REQ-2.1 (Data Isolation)
 */

import { log } from '../../log.js';

import type { CloudServices } from '../bootstrap.js';
import type { DocumentChunk, UserPreferences } from '../data-gateway/types.js';

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

            case 'hybrid_search':
                await handleHybridSearch(services, userId, requestId, request);
                break;

            case 'get_chat_history':
                await handleGetChatHistory(services, userId, requestId, request);
                break;

            case 'put_chat_message':
                await handlePutChatMessage(services, userId, request);
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

            case 'list_ingested_urls':
                await handleListIngestedUrls(services, userId, requestId, request);
                break;

            case 'delete_ingested_url':
                await handleDeleteIngestedUrl(services, userId, requestId, request);
                break;

            case 'upload_draft':
                await handleUploadDraft(services, userId, requestId, request);
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

            case 'put_user_preference':
                await handlePutUserPreference(services, userId, request);
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
    const origin = request.origin as string | undefined;

    if (!chunk || !userId) {
        log.warn('DataGateway worker: index_document missing chunk or userId');
        return;
    }

    // ── Corporate sentinel path ──
    // CORPORATE writes are allowed ONLY when origin === 'upload_worker'.
    // Any other origin attempting to write under userId='CORPORATE' is logged as abuse.
    // Requirements: data-isolation-corporate-docs Req 3.1, 3.2, 3.3.
    if (userId === 'CORPORATE') {
        if (origin !== 'upload_worker') {
            log.error('SECURITY: corporate_sentinel_abuse detected — rejecting index_document', {
                event: 'corporate_sentinel_abuse',
                origin: origin ?? '<unset>',
                chunkId: chunk.id,
                filename: chunk.filename,
            });
            return;
        }
        await services.dataGateway.indexCorporateDocument(chunk);
        log.debug('Indexed corporate document chunk', {
            chunkId: chunk.id,
            filename: chunk.filename,
        });
        return;
    }

    // ── Per-user path ──
    // Cross-user-access detection: if request claims a userId different from the
    // sub-agent's assigned userId, log the mismatch. The DataGateway itself enforces
    // isolation at the call boundary; this is an additional defence-in-depth log.
    const expectedUserId = request.expected_user_id as string | undefined;
    if (expectedUserId && expectedUserId !== userId) {
        log.error('SECURITY: cross_user_access detected on index_document — rejecting', {
            event: 'cross_user_access',
            requestUserId: userId,
            expectedUserId,
            chunkId: chunk.id,
        });
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

// ── Validation constants ──

const VALID_TECHNICAL_DEPTH = new Set(['detailed', 'high-level']);
const VALID_PRIMARY_DOMAIN = new Set(['frontend', 'infrastructure', 'data']);

async function handlePutUserPreference(
    services: CloudServices,
    userId: string,
    request: Record<string, unknown>,
): Promise<void> {
    if (!userId) return;

    const preferences = request.preferences as Partial<UserPreferences> | undefined;
    if (!preferences) return;

    // Validate persona enum fields before persisting
    if (preferences.technical_depth !== undefined && !VALID_TECHNICAL_DEPTH.has(preferences.technical_depth)) {
        log.warn('DataGateway worker: invalid technical_depth value', { userId, value: preferences.technical_depth });
        return;
    }
    if (preferences.primary_domain !== undefined && !VALID_PRIMARY_DOMAIN.has(preferences.primary_domain)) {
        log.warn('DataGateway worker: invalid primary_domain value', { userId, value: preferences.primary_domain });
        return;
    }

    // Merge with existing preferences (non-destructive — don't overwrite unrelated fields)
    const existing = await services.dataGateway.getUserPreference(userId);
    const merged = { ...existing, ...preferences } as UserPreferences;

    await services.dataGateway.putUserPreference(userId, merged);
    log.debug('Stored user preferences', { userId });
}

async function handleHybridSearch(
    services: CloudServices,
    userId: string,
    requestId: string | undefined,
    request: Record<string, unknown>,
): Promise<void> {
    if (!requestId || !userId) return;

    const query = request.query as string;
    const vector = request.vector as number[];
    const topK = (request.top_k as number) || 5;

    if (!query || !vector) {
        const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
        await services.redis.lpush(responseKey, JSON.stringify({
            success: false,
            error: 'Missing query or vector',
        }));
        await services.redis.expire(responseKey, 60);
        return;
    }

    const results = await services.dataGateway.hybridSearch(userId, query, vector, topK);

    const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
    await services.redis.lpush(responseKey, JSON.stringify({
        success: true,
        results,
    }));
    await services.redis.expire(responseKey, 60);
}

async function handleGetChatHistory(
    services: CloudServices,
    userId: string,
    requestId: string | undefined,
    request: Record<string, unknown>,
): Promise<void> {
    if (!requestId || !userId) return;

    const limit = (request.limit as number) || 30;
    const messages = await services.dataGateway.getChatHistory(userId, limit);

    const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
    await services.redis.lpush(responseKey, JSON.stringify({
        success: true,
        messages,
    }));
    await services.redis.expire(responseKey, 60);
}

async function handlePutChatMessage(
    services: CloudServices,
    userId: string,
    request: Record<string, unknown>,
): Promise<void> {
    if (!userId) return;

    const message = request.message as { messageId: string; role: string; content: string; timestamp: string } | undefined;
    if (!message) return;

    await services.dataGateway.putChatMessage(userId, {
        messageId: message.messageId,
        role: message.role as 'user' | 'assistant',
        content: message.content,
        timestamp: message.timestamp,
    });
}

async function handleListIngestedUrls(
    services: CloudServices,
    userId: string,
    requestId: string | undefined,
    request: Record<string, unknown>,
): Promise<void> {
    const limit = (request.limit as number) || 20;
    let urls: Array<{ url: string; filename: string; chunkCount: number; uploadedAt: string }> = [];
    try {
        urls = await services.dataGateway.listIngestedUrls(userId, limit);
    } catch (err) {
        log.error('list_ingested_urls failed', { userId, err });
        if (requestId) {
            const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
            await services.redis.lpush(responseKey, JSON.stringify({ success: false, error: (err as Error).message }));
            await services.redis.expire(responseKey, 60);
        }
        return;
    }
    if (requestId) {
        const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
        await services.redis.lpush(responseKey, JSON.stringify({ success: true, urls }));
        await services.redis.expire(responseKey, 60);
    }
}

async function handleDeleteIngestedUrl(
    services: CloudServices,
    userId: string,
    requestId: string | undefined,
    request: Record<string, unknown>,
): Promise<void> {
    const url = request.url as string;
    let deleted = 0;
    try {
        deleted = await services.dataGateway.deleteIngestedUrl(userId, url);
        log.info('Deleted ingested URL', { userId, url, deleted });
    } catch (err) {
        log.error('delete_ingested_url failed', { userId, url, err });
        if (requestId) {
            const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
            await services.redis.lpush(responseKey, JSON.stringify({ success: false, error: (err as Error).message }));
            await services.redis.expire(responseKey, 60);
        }
        return;
    }
    if (requestId) {
        const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
        await services.redis.lpush(responseKey, JSON.stringify({ success: true, deleted }));
        await services.redis.expire(responseKey, 60);
    }
}

async function handleUploadDraft(
    services: CloudServices,
    userId: string,
    requestId: string | undefined,
    request: Record<string, unknown>,
): Promise<void> {
    const filename = request.filename as string;
    const contentB64 = request.content_b64 as string;
    const contentType = (request.content_type as string) || 'application/octet-stream';
    if (!filename || !contentB64) {
        if (requestId) {
            const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
            await services.redis.lpush(responseKey, JSON.stringify({ success: false, error: 'filename and content_b64 are required' }));
            await services.redis.expire(responseKey, 60);
        }
        return;
    }
    try {
        const buf = Buffer.from(contentB64, 'base64');
        const result = await services.dataGateway.uploadDraft(userId, filename, buf, contentType);
        log.info('Uploaded draft', { userId, key: result.key, size: buf.length });
        if (requestId) {
            const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
            await services.redis.lpush(responseKey, JSON.stringify({ success: true, ...result }));
            await services.redis.expire(responseKey, 60);
        }
    } catch (err) {
        log.error('upload_draft failed', { userId, filename, err });
        if (requestId) {
            const responseKey = `queue:agent:${userId}:dg_response:${requestId}`;
            await services.redis.lpush(responseKey, JSON.stringify({ success: false, error: (err as Error).message }));
            await services.redis.expire(responseKey, 60);
        }
    }
}
