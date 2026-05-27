/**
 * Upload Worker — consumes the `nanoclaw:uploads:pending` Redis list and
 * dispatches document processing tasks to per-user sub-agent queues.
 *
 * This bridges the gap between:
 *   1. Admin dashboard upload → S3 staging + Redis enqueue
 *   2. Sub-agent document processing (extract → chunk → embed → index)
 *
 * The worker runs as part of the orchestrator process in cloud mode.
 * It polls the pending uploads list and for each upload:
 *   - Validates the S3 object exists
 *   - Determines the userId (from upload metadata or admin context)
 *   - Enqueues a `document_upload` message to the user's agent queue
 *   - Updates the upload status
 *
 * Requirements: REQ-5.1 (Document Processing Pipeline)
 */

import crypto from 'node:crypto';

import { log } from '../../log.js';

import type { CloudServices } from '../bootstrap.js';

// ── Types ──

interface PendingUpload {
    uploadId: string;
    filename: string;
    contentType: string;
    s3Key: string;
    bucket: string;
    timestamp: string;
    userId?: string; // Set if upload came from a specific user context
    /**
     * If true, this upload is a corporate document — admin-uploaded, searchable
     * by every user via the CORPORATE sentinel. The upload-worker enforces:
     *   - S3 key prefix `corporate/{uploadId}/{filename}` (overrides user-prefix scheme)
     *   - downstream index_document messages carry userId='CORPORATE' + origin='upload_worker'
     * See data-isolation-corporate-docs spec, Tasks 4.1 / 4.2.
     */
    corporate?: boolean;
}

interface UploadWorkerConfig {
    /** Redis list key to consume from */
    queueKey: string;
    /** Poll interval in ms when queue is empty */
    pollIntervalMs: number;
    /** Default userId for admin-uploaded documents (corporate docs) */
    defaultUserId: string;
}

const DEFAULT_CONFIG: UploadWorkerConfig = {
    queueKey: 'nanoclaw:uploads:pending',
    pollIntervalMs: 2000,
    defaultUserId: 'admin',
};

// ── Worker State ──

let running = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// ── Public API ──

/**
 * Start the upload worker. Polls the pending uploads Redis list and
 * dispatches processing tasks to sub-agent queues.
 */
export function startUploadWorker(services: CloudServices, config?: Partial<UploadWorkerConfig>): void {
    if (running) return;

    const cfg = { ...DEFAULT_CONFIG, ...config };
    running = true;

    log.info('Upload worker started', { queueKey: cfg.queueKey });
    void pollLoop(services, cfg);
}

/**
 * Stop the upload worker gracefully.
 */
export function stopUploadWorker(): void {
    running = false;
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    log.info('Upload worker stopped');
}

// ── Internal ──

async function pollLoop(services: CloudServices, config: UploadWorkerConfig): Promise<void> {
    if (!running) return;

    try {
        const processed = await processNextUpload(services, config);

        if (processed) {
            // Immediately check for more work (no delay)
            pollTimer = setTimeout(() => pollLoop(services, config), 0);
        } else {
            // Queue empty — wait before polling again
            pollTimer = setTimeout(() => pollLoop(services, config), config.pollIntervalMs);
        }
    } catch (err) {
        log.error('Upload worker poll error', { err });
        // Back off on error
        pollTimer = setTimeout(() => pollLoop(services, config), config.pollIntervalMs * 2);
    }
}

async function processNextUpload(services: CloudServices, config: UploadWorkerConfig): Promise<boolean> {
    // RPOP from the pending uploads list (non-blocking)
    const raw = await services.redis.rpop(config.queueKey);
    if (!raw) return false;

    let upload: PendingUpload;
    try {
        upload = JSON.parse(raw) as PendingUpload;
    } catch (err) {
        log.error('Upload worker: failed to parse pending upload', { raw, err });
        return true; // consumed the message, move on
    }

    log.info('Upload worker: processing upload', {
        uploadId: upload.uploadId,
        filename: upload.filename,
        contentType: upload.contentType,
    });

    try {
        // ── Corporate vs per-user routing ──
        // data-isolation-corporate-docs Tasks 4.1, 4.2:
        //   corporate=true  → s3 key under corporate/{uploadId}/{filename}, target userId='CORPORATE',
        //                     downstream index_document calls MUST carry origin='upload_worker'
        //   corporate=false → unchanged: dispatch to the supplied userId's queue,
        //                     storing under {userId}/documents/{filename}
        const isCorporate = upload.corporate === true;
        let userId: string;
        let s3Key: string;

        if (isCorporate) {
            userId = 'CORPORATE';
            s3Key = `corporate/${upload.uploadId}/${upload.filename}`;
        } else {
            userId = upload.userId || config.defaultUserId;
            s3Key = upload.s3Key && upload.s3Key.startsWith(`${userId}/`)
                ? upload.s3Key
                : `${userId}/documents/${upload.filename}`;
        }

        // Enqueue a document_upload message to the user's sub-agent queue.
        // For corporate uploads, the message is dispatched to the admin queue
        // (userId='CORPORATE'), and the receiving processor MUST set
        // origin='upload_worker' when calling index_document on the
        // DataGateway Worker (enforced in data-gateway-worker/index.ts).
        await services.messageQueue.enqueueForAgent(userId, {
            id: `upload-${upload.uploadId}`,
            userId,
            type: 'document_upload',
            payload: {
                uploadId: upload.uploadId,
                filename: upload.filename,
                contentType: upload.contentType,
                s3Key,
                bucket: upload.bucket,
                timestamp: upload.timestamp,
                corporate: isCorporate,
                // Propagate origin so the downstream data-gateway-worker call carries it.
                origin: 'upload_worker',
            },
            timestamp: new Date().toISOString(),
        });

        log.info('Upload worker: dispatched to sub-agent queue', {
            uploadId: upload.uploadId,
            userId,
            corporate: isCorporate,
            s3Key,
            filename: upload.filename,
        });

        return true;
    } catch (err) {
        log.error('Upload worker: failed to dispatch upload', {
            uploadId: upload.uploadId,
            filename: upload.filename,
            err,
        });

        // Move to DLQ for retry
        try {
            await services.messageQueue.moveToDLQ(
                {
                    id: `upload-${upload.uploadId}`,
                    userId: upload.userId || config.defaultUserId,
                    type: 'document_upload',
                    payload: upload as unknown as Record<string, unknown>,
                    timestamp: new Date().toISOString(),
                },
                (err as Error).message,
            );
        } catch (dlqErr) {
            log.error('Upload worker: DLQ enqueue also failed', { uploadId: upload.uploadId, dlqErr });
        }

        return true;
    }
}
