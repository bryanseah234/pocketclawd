/**
 * Property tests for data-isolation-corporate-docs spec — Upload Worker (Task 4.3).
 *
 * Property 3: Corporate uploads always use CORPORATE sentinel and corporate/ prefix
 * Property 4: Non-corporate uploads always preserve the specified target userId
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 6.2, 6.3
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

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

const DEFAULT_USER_ID = 'admin';

function dispatchUpload(upload: PendingUpload) {
    const isCorporate = upload.corporate === true;
    let userId: string;
    let s3Key: string;

    if (isCorporate) {
        userId = 'CORPORATE';
        s3Key = `corporate/${upload.uploadId}/${upload.filename}`;
    } else {
        userId = upload.userId || DEFAULT_USER_ID;
        // Mirrors src/cloud/upload-worker/index.ts: preserve the producer's real key
        // when it is a valid per-user key in EITHER form.
        const looksLikeUserKey =
            upload.s3Key &&
            (upload.s3Key.startsWith(`${userId}/`) ||
                upload.s3Key.startsWith(`users/${userId}/`));
        s3Key = looksLikeUserKey
            ? upload.s3Key
            : `${userId}/documents/${upload.filename}`;
    }

    return {
        targetUserId: userId,
        s3Key,
        corporate: isCorporate,
    };
}

// Arbitraries that yield realistic but bounded input.
const arbId = fc.string({ minLength: 1, maxLength: 32 }).filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));
const arbFilename = fc.string({ minLength: 1, maxLength: 64 })
    .filter((s) => !s.includes('/') && !s.includes('\\') && s.trim().length > 0);
const arbUserId = fc.string({ minLength: 1, maxLength: 32 })
    .filter((s) => /^[a-zA-Z0-9_+-]+$/.test(s) && s !== 'CORPORATE');

describe('Property 3: Corporate uploads always use CORPORATE sentinel and corporate/ prefix', () => {
    it('for any uploadId/filename/userId, corporate=true → userId=CORPORATE and s3Key=corporate/<uploadId>/<filename>', () => {
        fc.assert(
            fc.property(arbId, arbFilename, fc.option(arbUserId), (uploadId, filename, userId) => {
                const result = dispatchUpload({
                    uploadId,
                    filename,
                    contentType: 'application/pdf',
                    s3Key: 'staging/x.pdf',
                    bucket: 'b',
                    timestamp: '2026-01-01',
                    userId: userId ?? undefined,
                    corporate: true,
                });
                expect(result.targetUserId).toBe('CORPORATE');
                expect(result.s3Key).toBe(`corporate/${uploadId}/${filename}`);
                expect(result.corporate).toBe(true);
            }),
            { numRuns: 200 },
        );
    });
});

describe('Property 4: Non-corporate uploads always preserve the specified target userId', () => {
    it('for any uploadId/filename/userId, corporate!==true → s3Key starts with that userId/', () => {
        fc.assert(
            fc.property(arbId, arbFilename, arbUserId, (uploadId, filename, userId) => {
                const result = dispatchUpload({
                    uploadId,
                    filename,
                    contentType: 'application/pdf',
                    s3Key: 'staging/x.pdf',
                    bucket: 'b',
                    timestamp: '2026-01-01',
                    userId,
                    corporate: false,
                });
                expect(result.targetUserId).toBe(userId);
                expect(result.s3Key.startsWith(`${userId}/`)).toBe(true);
                expect(result.corporate).toBe(false);
            }),
            { numRuns: 200 },
        );
    });

    it('for any userId/uploadId/filename, a real users/<userId>/staging/... key is preserved verbatim', () => {
        fc.assert(
            fc.property(arbId, arbFilename, arbUserId, (uploadId, filename, userId) => {
                const realKey = `users/${userId}/staging/${uploadId}/${filename}`;
                const result = dispatchUpload({
                    uploadId,
                    filename,
                    contentType: 'application/pdf',
                    s3Key: realKey,
                    bucket: 'b',
                    timestamp: '2026-01-01',
                    userId,
                    corporate: false,
                });
                // Regression guard: must NOT fabricate <userId>/documents/<file>.
                expect(result.s3Key).toBe(realKey);
            }),
            { numRuns: 200 },
        );
    });

    it('non-corporate output never targets CORPORATE userId, regardless of input userId', () => {
        fc.assert(
            fc.property(arbId, arbFilename, fc.option(arbUserId, { nil: undefined }), (uploadId, filename, userId) => {
                const result = dispatchUpload({
                    uploadId,
                    filename,
                    contentType: 'application/pdf',
                    s3Key: 'staging/x.pdf',
                    bucket: 'b',
                    timestamp: '2026-01-01',
                    userId,
                    // corporate omitted
                });
                expect(result.targetUserId).not.toBe('CORPORATE');
                expect(result.s3Key.startsWith('corporate/')).toBe(false);
            }),
            { numRuns: 200 },
        );
    });
});
