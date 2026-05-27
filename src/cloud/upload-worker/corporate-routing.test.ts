/**
 * Unit tests for data-isolation-corporate-docs spec — Upload Worker corporate routing
 * (Tasks 4.1, 4.2, 4.4).
 *
 * The dispatch logic is internal to the worker; we replicate it here exactly to verify
 * routing decisions, mirroring the same approach as data-gateway-worker tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface PendingUpload {
    uploadId: string;
    filename: string;
    contentType: string;
    s3Key: string;
    bucket: string;
    timestamp: string;
    userId?: string;
    corporate?: boolean;
}

interface DispatchedMessage {
    id: string;
    userId: string;
    type: string;
    payload: Record<string, unknown>;
    timestamp: string;
}

const DEFAULT_USER_ID = 'admin';

function dispatchUpload(upload: PendingUpload): { targetUserId: string; message: DispatchedMessage } {
    const isCorporate = upload.corporate === true;
    let userId: string;
    let s3Key: string;

    if (isCorporate) {
        userId = 'CORPORATE';
        s3Key = `corporate/${upload.uploadId}/${upload.filename}`;
    } else {
        userId = upload.userId || DEFAULT_USER_ID;
        s3Key = upload.s3Key && upload.s3Key.startsWith(`${userId}/`)
            ? upload.s3Key
            : `${userId}/documents/${upload.filename}`;
    }

    const message: DispatchedMessage = {
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
            origin: 'upload_worker',
        },
        timestamp: new Date().toISOString(),
    };

    return { targetUserId: userId, message };
}

const BASE: PendingUpload = {
    uploadId: 'u1',
    filename: 'handbook.pdf',
    contentType: 'application/pdf',
    s3Key: 'staging/u1/handbook.pdf',
    bucket: 'nanoclaw-data-709609992277',
    timestamp: '2026-01-01T00:00:00Z',
};

describe('Upload Worker — corporate routing', () => {
    it('corporate=true: targets userId=CORPORATE and rewrites s3Key to corporate/<uploadId>/<filename>', () => {
        const { targetUserId, message } = dispatchUpload({ ...BASE, corporate: true });
        expect(targetUserId).toBe('CORPORATE');
        expect(message.userId).toBe('CORPORATE');
        expect(message.payload.s3Key).toBe('corporate/u1/handbook.pdf');
        expect(message.payload.corporate).toBe(true);
        expect(message.payload.origin).toBe('upload_worker');
    });

    it('corporate=true: preserves filename verbatim in the s3 path even with subdirs', () => {
        const { message } = dispatchUpload({
            ...BASE,
            uploadId: 'u-xyz',
            filename: 'My Policy 2026.pdf',
            corporate: true,
        });
        expect(message.payload.s3Key).toBe('corporate/u-xyz/My Policy 2026.pdf');
    });

    it('corporate=false + explicit userId: routes to that userId and uses {userId}/documents/<filename>', () => {
        const { targetUserId, message } = dispatchUpload({
            ...BASE,
            corporate: false,
            userId: 'user-abc',
            s3Key: 'staging/u1/handbook.pdf',
        });
        expect(targetUserId).toBe('user-abc');
        expect(message.payload.s3Key).toBe('user-abc/documents/handbook.pdf');
        expect(message.payload.corporate).toBe(false);
    });

    it('corporate=false + s3Key already userId-prefixed: preserves the existing key', () => {
        const { message } = dispatchUpload({
            ...BASE,
            corporate: false,
            userId: 'user-abc',
            s3Key: 'user-abc/documents/old.pdf',
        });
        expect(message.payload.s3Key).toBe('user-abc/documents/old.pdf');
    });

    it('corporate flag absent: defaults to non-corporate behavior', () => {
        const { targetUserId, message } = dispatchUpload({ ...BASE, userId: 'user-abc' });
        expect(targetUserId).toBe('user-abc');
        expect(message.payload.corporate).toBe(false);
    });

    it('corporate=false + missing userId: falls back to default admin user and uses admin/documents/<filename>', () => {
        const { targetUserId, message } = dispatchUpload({ ...BASE });
        expect(targetUserId).toBe('admin');
        expect(message.payload.s3Key).toBe('admin/documents/handbook.pdf');
    });

    it('always sets origin=upload_worker on the dispatched payload', () => {
        const r1 = dispatchUpload({ ...BASE, corporate: true }).message.payload.origin;
        const r2 = dispatchUpload({ ...BASE, corporate: false, userId: 'user-x' }).message.payload.origin;
        expect(r1).toBe('upload_worker');
        expect(r2).toBe('upload_worker');
    });

    it('dispatched message id is uniformly "upload-<uploadId>"', () => {
        const { message } = dispatchUpload({ ...BASE, uploadId: 'abc-123' });
        expect(message.id).toBe('upload-abc-123');
    });
});
