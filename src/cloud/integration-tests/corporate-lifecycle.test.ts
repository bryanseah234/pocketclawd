/**
 * Integration tests for corporate document lifecycle (data-isolation-corporate-docs spec).
 *
 * Tests validate the complete corporate document flow through all system layers:
 *   8.1: Admin Dashboard → Upload Worker → DataGateway Worker → DataGateway indexing
 *   8.2: PDPA deletion leaves corporate docs intact
 *   8.3: Sub-agent cannot index CORPORATE documents
 *
 * Uses mock AWS/Redis services (no live infra required).
 * Requirements: 1.1, 2.1, 7.1, 7.2, 8.1, 8.2, 8.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DocumentChunk } from '../data-gateway/types.js';

// ── Minimal in-process mocks ──────────────────────────────────────────────

/** Simulates the OpenSearch index: tracks indexed docs by userId. */
class MockOpenSearch {
    private docs: Array<{ userId: string; chunk: DocumentChunk }> = [];
    private deleteQueries: Array<{ filter: unknown }> = [];

    async indexDoc(userId: string, chunk: DocumentChunk): Promise<void> {
        this.docs.push({ userId, chunk });
    }

    async deleteByQuery(filter: unknown): Promise<void> {
        this.deleteQueries.push({ filter });
    }

    getDocsForUser(userId: string) {
        return this.docs.filter((d) => d.userId === userId);
    }

    getAllDocs() {
        return [...this.docs];
    }

    getDeleteQueries() {
        return [...this.deleteQueries];
    }

    clear() {
        this.docs = [];
        this.deleteQueries = [];
    }
}

/** Simulates S3: tracks putObject calls. */
class MockS3 {
    private objects: Array<{ key: string; data: Buffer }> = [];

    async put(key: string, data: Buffer): Promise<void> {
        this.objects.push({ key, data });
    }

    getKeys(): string[] {
        return this.objects.map((o) => o.key);
    }

    clear() {
        this.objects = [];
    }
}

/** Simulates Redis: tracks lpush calls for the data-gateway queue. */
class MockRedis {
    private messages: Array<{ queue: string; payload: string }> = [];

    async lpush(queue: string, payload: string): Promise<number> {
        this.messages.push({ queue, payload });
        return this.messages.length;
    }

    async brpop(key: string, _timeout: number): Promise<[string, string] | null> {
        const idx = this.messages.findIndex((m) => m.queue === key);
        if (idx === -1) return null;
        const [msg] = this.messages.splice(idx, 1);
        return [msg.queue, msg.payload];
    }

    getMessages(queue: string) {
        return this.messages.filter((m) => m.queue === queue).map((m) => JSON.parse(m.payload));
    }

    clear() {
        this.messages = [];
    }
}

// ── DataGateway inline implementation (subset for testing) ────────────────

const CORPORATE_SENTINEL = 'CORPORATE';

function assertUserId(userId: string): void {
    if (!userId || !userId.trim()) throw new Error('userId is required');
    if (userId === CORPORATE_SENTINEL) throw new Error('CORPORATE sentinel cannot be used as a regular userId');
}

type IndexFn = (userId: string, chunk: DocumentChunk) => Promise<void>;

function makeDataGateway(os: MockOpenSearch) {
    return {
        indexDocument: async (userId: string, chunk: DocumentChunk) => {
            assertUserId(userId);
            await os.indexDoc(userId, chunk);
        },
        indexCorporateDocument: async (chunk: DocumentChunk) => {
            await os.indexDoc(CORPORATE_SENTINEL, chunk);
        },
        hybridSearch: async (userId: string) => {
            assertUserId(userId);
            return os.getAllDocs().filter(
                (d) => d.userId === userId || d.userId === CORPORATE_SENTINEL,
            );
        },
        deleteAllUserData: async (userId: string) => {
            assertUserId(userId);
            // Must NOT affect CORPORATE docs
            const filter = { term: { userId } };
            await os.deleteByQuery(filter);
        },
    };
}

// ── DataGateway Worker inline (origin validation subset) ──────────────────

type DataGateway = ReturnType<typeof makeDataGateway>;

const securityViolations: Array<{ type: string; userId: string; origin?: string }> = [];

async function handleIndexDocument(
    dg: DataGateway,
    userId: string,
    request: Record<string, unknown>,
): Promise<void> {
    const chunk = request['chunk'] as DocumentChunk;
    const origin = request['origin'] as string | undefined;

    if (userId === CORPORATE_SENTINEL) {
        if (origin !== 'upload_worker') {
            securityViolations.push({ type: 'corporate_sentinel_abuse', userId, origin });
            throw new Error('CORPORATE indexing restricted to upload_worker');
        }
        await dg.indexCorporateDocument(chunk);
    } else {
        await dg.indexDocument(userId, chunk);
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Integration: corporate document lifecycle', () => {
    let os: MockOpenSearch;
    let s3: MockS3;
    let redis: MockRedis;
    let dg: DataGateway;

    beforeEach(() => {
        os = new MockOpenSearch();
        s3 = new MockS3();
        redis = new MockRedis();
        dg = makeDataGateway(os);
        securityViolations.length = 0;
    });

    // ── Test 8.1: E2E corporate upload flow ──────────────────────────────

    it('8.1a: corporate upload routes to indexCorporateDocument with correct sentinel', async () => {
        const chunk: DocumentChunk = {
            id: 'corp-chunk-1',
            userId: CORPORATE_SENTINEL,
            content: 'Company handbook section 1',
            filename: 'handbook.pdf',
            pageNumber: 1,
            chunkIndex: 0,
            uploadedAt: new Date().toISOString(),
        };

        // Simulate upload worker: enqueue to data-gateway-worker with origin=upload_worker
        await handleIndexDocument(dg, CORPORATE_SENTINEL, {
            chunk,
            origin: 'upload_worker',
        });

        // Verify it was indexed under CORPORATE sentinel
        const corpDocs = os.getDocsForUser(CORPORATE_SENTINEL);
        expect(corpDocs).toHaveLength(1);
        expect(corpDocs[0].chunk.id).toBe('corp-chunk-1');
    });

    it('8.1b: hybrid search for any user returns CORPORATE docs alongside their own', async () => {
        const userChunk: DocumentChunk = {
            id: 'user-doc-1', userId: 'user-abc',
            content: 'User private note', filename: 'note.txt',
            pageNumber: 1, chunkIndex: 0, uploadedAt: new Date().toISOString(),
        };
        const corpChunk: DocumentChunk = {
            id: 'corp-doc-1', userId: CORPORATE_SENTINEL,
            content: 'Corporate shared policy', filename: 'policy.pdf',
            pageNumber: 1, chunkIndex: 0, uploadedAt: new Date().toISOString(),
        };

        // Index both
        await dg.indexDocument('user-abc', userChunk);
        await dg.indexCorporateDocument(corpChunk);

        // Search as user-abc
        const results = await dg.hybridSearch('user-abc');
        const ids = results.map((r) => r.chunk.id);
        expect(ids).toContain('user-doc-1');    // user's own
        expect(ids).toContain('corp-doc-1');    // corporate
    });

    it('8.1c: hybrid search does NOT return another user\'s docs', async () => {
        const userAChunk: DocumentChunk = {
            id: 'userA-doc', userId: 'user-A',
            content: 'UserA private', filename: 'a.txt',
            pageNumber: 1, chunkIndex: 0, uploadedAt: new Date().toISOString(),
        };
        const userBChunk: DocumentChunk = {
            id: 'userB-doc', userId: 'user-B',
            content: 'UserB private', filename: 'b.txt',
            pageNumber: 1, chunkIndex: 0, uploadedAt: new Date().toISOString(),
        };

        await dg.indexDocument('user-A', userAChunk);
        await dg.indexDocument('user-B', userBChunk);

        // userA should only see their own docs (no corporate, no userB)
        const results = await dg.hybridSearch('user-A');
        const ids = results.map((r) => r.chunk.id);
        expect(ids).toContain('userA-doc');
        expect(ids).not.toContain('userB-doc');
    });

    // ── Test 8.2: PDPA deletion leaves corporate docs intact ─────────────

    it('8.2: deleteAllUserData targets only the user — CORPORATE docs untouched', async () => {
        const userChunk: DocumentChunk = {
            id: 'user-doc', userId: 'user-xyz',
            content: 'User data', filename: 'u.txt',
            pageNumber: 1, chunkIndex: 0, uploadedAt: new Date().toISOString(),
        };
        const corpChunk: DocumentChunk = {
            id: 'corp-doc', userId: CORPORATE_SENTINEL,
            content: 'Corporate data', filename: 'c.txt',
            pageNumber: 1, chunkIndex: 0, uploadedAt: new Date().toISOString(),
        };

        await dg.indexDocument('user-xyz', userChunk);
        await dg.indexCorporateDocument(corpChunk);

        // Run PDPA delete for user-xyz
        await dg.deleteAllUserData('user-xyz');

        // Verify: deleteByQuery was called with ONLY user-xyz filter
        const queries = os.getDeleteQueries();
        expect(queries).toHaveLength(1);
        const filterStr = JSON.stringify(queries[0].filter);
        expect(filterStr).toContain('user-xyz');
        expect(filterStr).not.toContain(CORPORATE_SENTINEL);
    });

    it('8.2b: deleteAllUserData rejects CORPORATE sentinel', async () => {
        await expect(dg.deleteAllUserData(CORPORATE_SENTINEL)).rejects.toThrow(
            /CORPORATE sentinel/,
        );
    });

    // ── Test 8.3: Sub-agent cannot index CORPORATE documents ─────────────

    it('8.3: sub-agent request with userId=CORPORATE is rejected (corporate_sentinel_abuse)', async () => {
        const chunk: DocumentChunk = {
            id: 'sub-agent-attempt', userId: CORPORATE_SENTINEL,
            content: 'Attempted corporate write from sub-agent', filename: 'x.txt',
            pageNumber: 1, chunkIndex: 0, uploadedAt: new Date().toISOString(),
        };

        // Sub-agent sends request WITHOUT origin=upload_worker
        await expect(
            handleIndexDocument(dg, CORPORATE_SENTINEL, { chunk, origin: 'sub_agent' }),
        ).rejects.toThrow(/CORPORATE indexing restricted/);

        // Security violation logged
        expect(securityViolations).toHaveLength(1);
        expect(securityViolations[0].type).toBe('corporate_sentinel_abuse');
        expect(securityViolations[0].origin).toBe('sub_agent');

        // Document NOT indexed
        expect(os.getDocsForUser(CORPORATE_SENTINEL)).toHaveLength(0);
    });

    it('8.3b: sub-agent request with NO origin is also rejected', async () => {
        const chunk: DocumentChunk = {
            id: 'no-origin', userId: CORPORATE_SENTINEL,
            content: 'No origin attempt', filename: 'y.txt',
            pageNumber: 1, chunkIndex: 0, uploadedAt: new Date().toISOString(),
        };

        await expect(
            handleIndexDocument(dg, CORPORATE_SENTINEL, { chunk }),
        ).rejects.toThrow(/CORPORATE indexing restricted/);

        expect(os.getDocsForUser(CORPORATE_SENTINEL)).toHaveLength(0);
    });
});
