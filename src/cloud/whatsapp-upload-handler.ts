/**
 * WhatsApp Upload Handler — processes file attachments from WhatsApp messages.
 *
 * When a user sends a document/image via WhatsApp, this handler:
 * 1. Downloads the media from WhatsApp (via Baileys downloadMediaMessage)
 * 2. Uploads to S3 staging/ prefix
 * 3. Enqueues a document_upload message to the user's sub-agent queue
 *
 * Integrates with the existing upload pipeline (upload worker → sub-agent → DataGateway).
 *
 * Requirements: REQ-6.1 (WhatsApp file handling), REQ-5.1 (Document processing)
 */

import crypto from 'node:crypto';

import { log } from '../log.js';

import type { CloudServices } from './bootstrap.js';

// Supported MIME types for document processing
const SUPPORTED_MIME_TYPES = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'text/markdown',
    'image/jpeg',
    'image/png',
    'image/tiff',
]);

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB (WhatsApp limit)

export interface WhatsAppFileMessage {
    userId: string;
    filename: string;
    mimetype: string;
    buffer: Buffer;
    caption?: string;
}

/**
 * Handle a file attachment from WhatsApp.
 *
 * Downloads the media, validates it, uploads to S3 staging, and enqueues
 * for document processing.
 *
 * @returns A user-facing status message (acknowledgment or error).
 */
export async function handleWhatsAppFileUpload(
    services: CloudServices,
    file: WhatsAppFileMessage,
): Promise<string> {
    const { userId, filename, mimetype, buffer, caption } = file;

    // Validate MIME type
    if (!SUPPORTED_MIME_TYPES.has(mimetype)) {
        return `❌ Unsupported file type: ${mimetype}. Supported: PDF, DOCX, XLSX, PPTX, TXT, CSV, images.`;
    }

    // Validate file size
    if (buffer.length > MAX_FILE_SIZE) {
        const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
        return `❌ File too large (${sizeMB} MB). Maximum is 25 MB.`;
    }

    const uploadId = crypto.randomUUID();
    const bucket = services.config.s3.dataBucket;
    const s3Key = `staging/uploads/${uploadId}/${filename}`;

    try {
        // Upload to S3 staging
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: 'ap-southeast-1' });

        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: s3Key,
            Body: buffer,
            ContentType: mimetype,
            Metadata: { uploadId, originalFilename: filename, userId },
        }));

        // Enqueue for processing via the upload worker
        await services.redis.lpush('nanoclaw:uploads:pending', JSON.stringify({
            uploadId,
            filename,
            contentType: mimetype,
            s3Key,
            bucket,
            userId,
            caption: caption || '',
            timestamp: new Date().toISOString(),
        }));

        log.info('WhatsApp file uploaded to S3 and enqueued', {
            userId,
            filename,
            mimetype,
            size: buffer.length,
            uploadId,
        });

        return `📥 Processing "${filename}"... I'll let you know when it's ready for questions.`;
    } catch (err) {
        log.error('WhatsApp file upload failed', { userId, filename, err });
        return `❌ Failed to process "${filename}". Please try again.`;
    }
}

/**
 * Check if a MIME type is a supported document type for processing.
 */
export function isSupportedDocumentType(mimetype: string): boolean {
    return SUPPORTED_MIME_TYPES.has(mimetype);
}
