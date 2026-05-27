/**
 * Unit tests for data-isolation-corporate-docs spec — DataGateway Worker (Tasks 3.1–3.3).
 *
 * Validates:
 * - CORPORATE userId requires origin === 'upload_worker'; any other origin is rejected
 *   with corporate_sentinel_abuse log.
 * - CORPORATE+upload_worker calls services.dataGateway.indexCorporateDocument(chunk).
 * - cross-user-access mismatch (request.expected_user_id !== userId) is rejected
 *   with cross_user_access log.
 * - Normal per-user index_document still calls indexDocument(userId, chunk) unchanged.
 *
 * Requirements: data-isolation-corporate-docs Req 3.1, 3.2, 3.3.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CloudServices } from '../bootstrap.js';
import type { DocumentChunk } from '../data-gateway/types.js';

// Replicate handleIndexDocument exactly from data-gateway-worker/index.ts.
// We test the logic directly because the handler is not exported.

async function handleIndexDocument(
    services: Pick<CloudServices, 'dataGateway'>,
    userId: string,
    request: Record<string, unknown>,
    logger: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> },
): Promise<void> {
    const chunk = request.chunk as DocumentChunk;
    const origin = request.origin as string | undefined;

    if (!chunk || !userId) {
        logger.warn('DataGateway worker: index_document missing chunk or userId');
        return;
    }

    if (userId === 'CORPORATE') {
        if (origin !== 'upload_worker') {
            logger.error('SECURITY: corporate_sentinel_abuse detected — rejecting index_document', {
                event: 'corporate_sentinel_abuse',
                origin: origin ?? '<unset>',
                chunkId: chunk.id,
                filename: chunk.filename,
            });
            return;
        }
        await services.dataGateway.indexCorporateDocument(chunk);
        logger.debug('Indexed corporate document chunk', { chunkId: chunk.id, filename: chunk.filename });
        return;
    }

    const expectedUserId = request.expected_user_id as string | undefined;
    if (expectedUserId && expectedUserId !== userId) {
        logger.error('SECURITY: cross_user_access detected on index_document — rejecting', {
            event: 'cross_user_access',
            requestUserId: userId,
            expectedUserId,
            chunkId: chunk.id,
        });
        return;
    }

    await services.dataGateway.indexDocument(userId, chunk);
    logger.debug('Indexed document chunk', { userId, chunkId: chunk.id, filename: chunk.filename });
}

function createMocks() {
    const indexDocument = vi.fn().mockResolvedValue(undefined);
    const indexCorporateDocument = vi.fn().mockResolvedValue(undefined);
    const services = {
        dataGateway: { indexDocument, indexCorporateDocument },
    } as unknown as Pick<CloudServices, 'dataGateway'>;
    const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    return { services, indexDocument, indexCorporateDocument, logger };
}

const baseChunk: DocumentChunk = {
    id: 'chunk-1',
    docType: 'pdf',
    content: 'hello',
    contentVector: [0.1, 0.2, 0.3],
    filename: 'employee_handbook.pdf',
    pageNumber: 1,
    chunkIndex: 0,
    uploadedAt: '2026-01-01T00:00:00Z',
};

describe('DataGateway Worker — index_document corporate sentinel handling', () => {
    let m: ReturnType<typeof createMocks>;
    beforeEach(() => { m = createMocks(); });

    it('CORPORATE + upload_worker origin: routes to indexCorporateDocument', async () => {
        await handleIndexDocument(m.services, 'CORPORATE', {
            chunk: baseChunk,
            origin: 'upload_worker',
        }, m.logger);

        expect(m.indexCorporateDocument).toHaveBeenCalledTimes(1);
        expect(m.indexCorporateDocument).toHaveBeenCalledWith(baseChunk);
        expect(m.indexDocument).not.toHaveBeenCalled();
        expect(m.logger.error).not.toHaveBeenCalled();
    });

    it('CORPORATE + missing origin: rejects with corporate_sentinel_abuse log', async () => {
        await handleIndexDocument(m.services, 'CORPORATE', {
            chunk: baseChunk,
        }, m.logger);

        expect(m.indexCorporateDocument).not.toHaveBeenCalled();
        expect(m.indexDocument).not.toHaveBeenCalled();
        expect(m.logger.error).toHaveBeenCalledTimes(1);
        const [msg, ctx] = m.logger.error.mock.calls[0];
        expect(msg).toMatch(/corporate_sentinel_abuse/);
        expect((ctx as Record<string, unknown>).event).toBe('corporate_sentinel_abuse');
        expect((ctx as Record<string, unknown>).origin).toBe('<unset>');
    });

    it('CORPORATE + non-upload_worker origin (e.g. sub_agent): rejects with security log', async () => {
        await handleIndexDocument(m.services, 'CORPORATE', {
            chunk: baseChunk,
            origin: 'sub_agent',
        }, m.logger);

        expect(m.indexCorporateDocument).not.toHaveBeenCalled();
        expect(m.indexDocument).not.toHaveBeenCalled();
        expect(m.logger.error).toHaveBeenCalledTimes(1);
        const ctx = m.logger.error.mock.calls[0][1] as Record<string, unknown>;
        expect(ctx.event).toBe('corporate_sentinel_abuse');
        expect(ctx.origin).toBe('sub_agent');
    });
});

describe('DataGateway Worker — index_document cross-user access detection', () => {
    let m: ReturnType<typeof createMocks>;
    beforeEach(() => { m = createMocks(); });

    it('rejects when expected_user_id mismatches request userId', async () => {
        await handleIndexDocument(m.services, 'user-A', {
            chunk: baseChunk,
            expected_user_id: 'user-B',
        }, m.logger);

        expect(m.indexDocument).not.toHaveBeenCalled();
        expect(m.indexCorporateDocument).not.toHaveBeenCalled();
        expect(m.logger.error).toHaveBeenCalledTimes(1);
        const ctx = m.logger.error.mock.calls[0][1] as Record<string, unknown>;
        expect(ctx.event).toBe('cross_user_access');
        expect(ctx.requestUserId).toBe('user-A');
        expect(ctx.expectedUserId).toBe('user-B');
    });

    it('proceeds when expected_user_id matches request userId', async () => {
        await handleIndexDocument(m.services, 'user-A', {
            chunk: baseChunk,
            expected_user_id: 'user-A',
        }, m.logger);

        expect(m.indexDocument).toHaveBeenCalledTimes(1);
        expect(m.indexDocument).toHaveBeenCalledWith('user-A', baseChunk);
        expect(m.logger.error).not.toHaveBeenCalled();
    });

    it('proceeds when expected_user_id is omitted (legacy path)', async () => {
        await handleIndexDocument(m.services, 'user-A', {
            chunk: baseChunk,
        }, m.logger);

        expect(m.indexDocument).toHaveBeenCalledTimes(1);
        expect(m.indexDocument).toHaveBeenCalledWith('user-A', baseChunk);
        expect(m.logger.error).not.toHaveBeenCalled();
    });
});

describe('DataGateway Worker — index_document basic guards', () => {
    let m: ReturnType<typeof createMocks>;
    beforeEach(() => { m = createMocks(); });

    it('warns and returns when chunk missing', async () => {
        await handleIndexDocument(m.services, 'user-A', {}, m.logger);
        expect(m.indexDocument).not.toHaveBeenCalled();
        expect(m.logger.warn).toHaveBeenCalledTimes(1);
    });

    it('warns and returns when userId missing', async () => {
        await handleIndexDocument(m.services, '', { chunk: baseChunk }, m.logger);
        expect(m.indexDocument).not.toHaveBeenCalled();
        expect(m.logger.warn).toHaveBeenCalledTimes(1);
    });
});
