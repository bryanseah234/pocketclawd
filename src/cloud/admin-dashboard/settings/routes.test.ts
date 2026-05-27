/**
 * Unit tests for Settings API route handler.
 *
 * Tests the HTTP endpoints exposed by createSettingsRoutes():
 * - GET  /admin/api/settings          → all settings grouped by category
 * - PUT  /admin/api/settings          → bulk update with validation
 * - POST /admin/api/settings/apply    → trigger graceful restart
 * - POST /admin/api/settings/reset/:key → reset a setting to default
 * - POST /admin/api/settings/export   → export DB overrides
 * - POST /admin/api/settings/import   → bulk import settings
 *
 * Uses an in-memory SQLite database and mock HTTP request/response objects.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import http from 'node:http';
import { Readable, Writable } from 'node:stream';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

import { SettingsManager } from './settings-manager.js';
import { createSettingsRoutes } from './routes.js';

// ── Mocks ──

vi.mock('../../../env.js', () => ({
    readEnvFile: () => ({}),
}));

vi.mock('../../../modules/paths.js', () => ({
    envPath: () => 'logs',
}));

vi.mock('../../../log.js', () => ({
    log: {
        debug: () => { },
        info: () => { },
        warn: () => { },
        error: () => { },
        fatal: () => { },
    },
}));

// ── Test Helpers ──

function createTestDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    return db;
}

interface MockResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}

/**
 * Create a mock IncomingMessage with the given method, url, and optional body.
 */
function mockRequest(method: string, url: string, body?: string): http.IncomingMessage {
    const readable = new Readable();
    if (body !== undefined) {
        readable.push(body);
    }
    readable.push(null); // end of stream

    const req = readable as unknown as http.IncomingMessage;
    req.method = method;
    req.url = url;
    req.headers = { host: 'localhost:3000' };
    if (body !== undefined) {
        req.headers['content-type'] = 'application/json';
    }
    return req;
}

/**
 * Create a mock ServerResponse that captures status, headers, and body.
 */
function mockResponse(): { res: http.ServerResponse; getResult: () => MockResponse } {
    let statusCode = 200;
    let headers: Record<string, string> = {};
    let body = '';

    const writable = new Writable({
        write(chunk, _encoding, callback) {
            body += chunk.toString();
            callback();
        },
    });

    const res = writable as unknown as http.ServerResponse;

    res.writeHead = ((code: number, hdrs?: Record<string, string>) => {
        statusCode = code;
        if (hdrs) headers = { ...headers, ...hdrs };
        return res;
    }) as any;

    res.end = ((data?: string | Buffer) => {
        if (data) body += data.toString();
        return res;
    }) as any;

    return {
        res,
        getResult: () => ({ statusCode, headers, body }),
    };
}

function parseBody(result: MockResponse): any {
    return JSON.parse(result.body);
}

// ── Tests ──

describe('Settings API Routes', () => {
    let db: Database.Database;
    let manager: SettingsManager;
    let handler: ReturnType<typeof createSettingsRoutes>;
    let triggerRestart: Mock<() => Promise<{ success: boolean; message: string }>>;

    beforeEach(() => {
        db = createTestDb();
        manager = new SettingsManager(db, vi.fn());
        triggerRestart = vi.fn<() => Promise<{ success: boolean; message: string }>>()
            .mockResolvedValue({ success: true, message: 'Restarting...' });
        handler = createSettingsRoutes({ manager, triggerRestart });
    });

    describe('GET /admin/api/settings', () => {
        it('returns 200 with categories array structure', async () => {
            const req = mockRequest('GET', '/admin/api/settings');
            const { res, getResult } = mockResponse();

            const handled = await handler(req, res);

            expect(handled).toBe(true);
            const result = getResult();
            expect(result.statusCode).toBe(200);

            const data = parseBody(result);
            expect(data).toHaveProperty('categories');
            expect(Array.isArray(data.categories)).toBe(true);
            expect(data.categories.length).toBeGreaterThan(0);
        });

        it('returns settings grouped by category with correct metadata', async () => {
            const req = mockRequest('GET', '/admin/api/settings');
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const data = parseBody(getResult());
            const firstCategory = data.categories[0];
            expect(firstCategory).toHaveProperty('category');
            expect(firstCategory).toHaveProperty('settings');
            expect(Array.isArray(firstCategory.settings)).toBe(true);

            const firstSetting = firstCategory.settings[0];
            expect(firstSetting).toHaveProperty('key');
            expect(firstSetting).toHaveProperty('value');
            expect(firstSetting).toHaveProperty('source');
            expect(firstSetting).toHaveProperty('definition');
        });
    });

    describe('PUT /admin/api/settings', () => {
        it('returns 200 with updated array for valid payload', async () => {
            const body = JSON.stringify({ 'chat.archive_mode': 'all' });
            const req = mockRequest('PUT', '/admin/api/settings', body);
            const { res, getResult } = mockResponse();

            const handled = await handler(req, res);

            expect(handled).toBe(true);
            const result = getResult();
            expect(result.statusCode).toBe(200);

            const data = parseBody(result);
            expect(data).toHaveProperty('updated');
            expect(data.updated).toHaveLength(1);
            expect(data.updated[0]).toEqual({
                key: 'chat.archive_mode',
                value: 'all',
                requiresRestart: false,
            });
        });

        it('persists the setting value after PUT', async () => {
            const body = JSON.stringify({ 'chat.archive_mode': 'all' });
            const req = mockRequest('PUT', '/admin/api/settings', body);
            const { res } = mockResponse();

            await handler(req, res);

            expect(manager.getSetting('chat.archive_mode')).toBe('all');
        });

        it('returns 400 with field-level errors for invalid payload', async () => {
            const body = JSON.stringify({ 'ingestion.lookback_hours': 'abc' });
            const req = mockRequest('PUT', '/admin/api/settings', body);
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(400);

            const data = parseBody(result);
            expect(data).toHaveProperty('errors');
            expect(data.errors).toHaveLength(1);
            expect(data.errors[0].key).toBe('ingestion.lookback_hours');
            expect(data.errors[0].message).toContain('number');
        });

        it('returns 400 with error for unknown key', async () => {
            const body = JSON.stringify({ 'unknown.setting': 'value' });
            const req = mockRequest('PUT', '/admin/api/settings', body);
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(400);

            const data = parseBody(result);
            expect(data.errors).toHaveLength(1);
            expect(data.errors[0].key).toBe('unknown.setting');
            expect(data.errors[0].message).toBe('Unknown setting');
        });

        it('handles multiple settings in one request', async () => {
            const body = JSON.stringify({
                'chat.archive_mode': 'self',
                'ingestion.lookback_hours': '48',
            });
            const req = mockRequest('PUT', '/admin/api/settings', body);
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(200);

            const data = parseBody(result);
            expect(data.updated).toHaveLength(2);
        });

        it('returns 400 for invalid JSON body', async () => {
            const req = mockRequest('PUT', '/admin/api/settings', '{not valid json');
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(400);

            const data = parseBody(result);
            expect(data.error).toContain('Invalid JSON');
        });

        it('returns 400 for empty body', async () => {
            const req = mockRequest('PUT', '/admin/api/settings', '');
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(400);

            const data = parseBody(result);
            expect(data.error).toContain('empty');
        });
    });

    describe('POST /admin/api/settings/apply', () => {
        it('calls triggerRestart and returns 200 on success', async () => {
            const req = mockRequest('POST', '/admin/api/settings/apply');
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(200);
            expect(triggerRestart).toHaveBeenCalledTimes(1);

            const data = parseBody(result);
            expect(data.success).toBe(true);
            expect(data.message).toBe('Restarting...');
        });

        it('returns 500 when triggerRestart reports failure', async () => {
            triggerRestart.mockResolvedValue({ success: false, message: 'Restart failed: timeout' });

            const req = mockRequest('POST', '/admin/api/settings/apply');
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(500);

            const data = parseBody(result);
            expect(data.error).toBe('Restart failed: timeout');
        });

        it('returns 500 when triggerRestart throws', async () => {
            triggerRestart.mockRejectedValue(new Error('Connection refused'));

            const req = mockRequest('POST', '/admin/api/settings/apply');
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(500);

            const data = parseBody(result);
            expect(data.error).toBe('Connection refused');
        });

        it('applies settings from body before triggering restart', async () => {
            const body = JSON.stringify({ 'chat.archive_mode': 'all' });
            const req = mockRequest('POST', '/admin/api/settings/apply', body);
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(200);
            expect(manager.getSetting('chat.archive_mode')).toBe('all');
            expect(triggerRestart).toHaveBeenCalledTimes(1);
        });

        it('returns 200 with message when no triggerRestart is configured', async () => {
            const handlerNoRestart = createSettingsRoutes({ manager });
            const req = mockRequest('POST', '/admin/api/settings/apply');
            const { res, getResult } = mockResponse();

            await handlerNoRestart(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(200);

            const data = parseBody(result);
            expect(data.success).toBe(true);
            expect(data.message).toContain('not configured');
        });
    });

    describe('POST /admin/api/settings/export', () => {
        it('returns 200 with settings object', async () => {
            const req = mockRequest('POST', '/admin/api/settings/export');
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(200);

            const data = parseBody(result);
            expect(data).toHaveProperty('settings');
            expect(typeof data.settings).toBe('object');
        });

        it('returns DB overrides in the export', async () => {
            manager.updateSetting('chat.archive_mode', 'all', 'admin');

            const req = mockRequest('POST', '/admin/api/settings/export');
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const data = parseBody(getResult());
            expect(data.settings['chat.archive_mode']).toBe('all');
        });
    });

    describe('POST /admin/api/settings/import', () => {
        it('returns 200 with applied, skipped, and errors arrays', async () => {
            const body = JSON.stringify({
                'chat.archive_mode': 'all',
                'ingestion.lookback_hours': '48',
            });
            const req = mockRequest('POST', '/admin/api/settings/import', body);
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(200);

            const data = parseBody(result);
            expect(data).toHaveProperty('applied');
            expect(data).toHaveProperty('skipped');
            expect(data).toHaveProperty('errors');
            expect(data.applied).toContain('chat.archive_mode');
            expect(data.applied).toContain('ingestion.lookback_hours');
        });

        it('reports errors for invalid values in import', async () => {
            const body = JSON.stringify({
                'chat.archive_mode': 'invalid_mode',
                'unknown.key': 'value',
            });
            const req = mockRequest('POST', '/admin/api/settings/import', body);
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const data = parseBody(getResult());
            expect(data.errors).toHaveLength(2);
        });

        it('returns 400 for invalid JSON body', async () => {
            const req = mockRequest('POST', '/admin/api/settings/import', 'not json');
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(400);
        });
    });

    describe('POST /admin/api/settings/reset/:key', () => {
        it('returns 200 with reset result for a valid key', async () => {
            manager.updateSetting('chat.archive_mode', 'all', 'admin');

            const req = mockRequest('POST', '/admin/api/settings/reset/chat.archive_mode');
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(200);

            const data = parseBody(result);
            expect(data.key).toBe('chat.archive_mode');
            expect(data.previousValue).toBe('all');
            expect(data.newValue).toBe('off'); // schema default
            expect(data.source).toBe('default');
        });

        it('returns 404 for unknown key', async () => {
            const req = mockRequest('POST', '/admin/api/settings/reset/unknown.key');
            const { res, getResult } = mockResponse();

            await handler(req, res);

            const result = getResult();
            expect(result.statusCode).toBe(404);

            const data = parseBody(result);
            expect(data.error).toBe('Unknown setting');
        });
    });

    describe('URL routing', () => {
        it('returns false for non-settings URLs (pass-through)', async () => {
            const req = mockRequest('GET', '/admin/api/other');
            const { res } = mockResponse();

            const handled = await handler(req, res);
            expect(handled).toBe(false);
        });

        it('returns 404 for unmatched settings sub-paths', async () => {
            const req = mockRequest('GET', '/admin/api/settings/nonexistent/path');
            const { res, getResult } = mockResponse();

            const handled = await handler(req, res);

            expect(handled).toBe(true);
            const result = getResult();
            expect(result.statusCode).toBe(404);
        });
    });
});
