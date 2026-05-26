/**
 * Unit tests for the Admin Dashboard module.
 *
 * Tests cover:
 * - Authentication middleware
 * - Route handling (HTML, JSON endpoints, SSE)
 * - Data provider integration
 * - Error handling
 */

import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDashboardHtml } from './html.js';
import { handleAdminRequest, initAdminDashboard, shutdownAdminDashboard } from './index.js';

import type { DashboardDataProvider } from './types.js';

// ── Mock Data Provider ──

function createMockProvider(): DashboardDataProvider {
    return {
        getWhatsAppStatus: vi.fn().mockResolvedValue({
            connected: true,
            phoneNumber: '+6591234567',
            lastActivity: '2024-01-15T10:30:00Z',
            uptime: 3600,
            state: 'connected',
        }),
        getWhatsAppQr: vi.fn().mockResolvedValue({
            available: false,
            qrDataUrl: null,
            qrText: null,
            message: 'Already connected',
        }),
        disconnectWhatsApp: vi.fn().mockResolvedValue({
            success: true,
            message: 'Disconnected',
        }),
        reconnectWhatsApp: vi.fn().mockResolvedValue({
            success: true,
            message: 'Reconnecting...',
        }),
        getSystemHealth: vi.fn().mockResolvedValue({
            overallStatus: 'healthy',
            uptime: 7200,
            timestamp: '2024-01-15T10:30:00Z',
            services: [
                { name: 'Redis', status: 'healthy', latencyMs: 2, lastChecked: '2024-01-15T10:30:00Z' },
                { name: 'DynamoDB', status: 'healthy', latencyMs: 15, lastChecked: '2024-01-15T10:30:00Z' },
            ],
        }),
        getContainers: vi.fn().mockResolvedValue({
            total: 2,
            containers: [
                {
                    containerId: 'abc123def456',
                    userId: 'user-001-hash',
                    status: 'running',
                    uptime: 1800,
                    memoryUsageMb: 128.5,
                    cpuPercent: 12.3,
                    lastActivity: '2024-01-15T10:29:00Z',
                },
                {
                    containerId: 'xyz789ghi012',
                    userId: 'user-002-hash',
                    status: 'running',
                    uptime: 900,
                    memoryUsageMb: 64.2,
                    cpuPercent: 5.1,
                    lastActivity: '2024-01-15T10:28:00Z',
                },
            ],
        }),
        getRecentMessages: vi.fn().mockResolvedValue({
            messages: [],
            totalProcessed24h: 150,
        }),
        getStats: vi.fn().mockResolvedValue({
            globalMessagesPerMinute: 5,
            globalMessagesPerHour: 120,
            activeUsers: 3,
            topUsers: [],
            rateLimitHits24h: 2,
        }),
    };
}

// ── HTTP Test Helpers ──

function createMockReq(method: string, url: string, headers: Record<string, string> = {}): http.IncomingMessage {
    const req = new http.IncomingMessage(null as unknown as import('net').Socket);
    req.method = method;
    req.url = url;
    req.headers = headers;

    // Make it a readable stream that immediately ends (empty body)
    process.nextTick(() => {
        req.push(null);
    });

    return req;
}

interface MockResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    ended: boolean;
}

function createMockRes(): { res: http.ServerResponse; result: MockResponse } {
    const result: MockResponse = {
        statusCode: 200,
        headers: {},
        body: '',
        ended: false,
    };

    const res = {
        writeHead(status: number, headers?: Record<string, string>) {
            result.statusCode = status;
            if (headers) result.headers = { ...result.headers, ...headers };
            return res;
        },
        write(chunk: string) {
            result.body += chunk;
            return true;
        },
        end(data?: string) {
            if (data) result.body += data;
            result.ended = true;
        },
        on(_event: string, _handler: () => void) {
            return res;
        },
    } as unknown as http.ServerResponse;

    return { res, result };
}

// ── Tests ──

describe('Admin Dashboard', () => {
    let provider: DashboardDataProvider;

    beforeEach(() => {
        provider = createMockProvider();
        initAdminDashboard({ token: 'test-secret-token', provider });
    });

    afterEach(() => {
        shutdownAdminDashboard();
        vi.restoreAllMocks();
    });

    describe('Authentication', () => {
        it('rejects requests without auth header', async () => {
            const req = createMockReq('GET', '/admin');
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(401);
            expect(JSON.parse(result.body)).toEqual({ error: 'Unauthorized' });
        });

        it('rejects requests with wrong token', async () => {
            const req = createMockReq('GET', '/admin', {
                authorization: 'Bearer wrong-token',
            });
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(401);
        });

        it('accepts requests with correct bearer token', async () => {
            const req = createMockReq('GET', '/admin', {
                authorization: 'Bearer test-secret-token',
            });
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(200);
            expect(result.headers['Content-Type']).toContain('text/html');
        });

        it('allows all requests when no token is configured', async () => {
            shutdownAdminDashboard();
            initAdminDashboard({ token: '', provider });

            const req = createMockReq('GET', '/admin');
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(200);
        });
    });

    describe('Route: GET /admin', () => {
        it('serves the HTML dashboard', async () => {
            const req = createMockReq('GET', '/admin', {
                authorization: 'Bearer test-secret-token',
            });
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(200);
            expect(result.headers['Content-Type']).toContain('text/html');
            expect(result.body).toContain('NanoClaw Admin');
            expect(result.body).toContain('<!DOCTYPE html>');
        });

        it('handles trailing slash', async () => {
            const req = createMockReq('GET', '/admin/', {
                authorization: 'Bearer test-secret-token',
            });
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(200);
            expect(result.body).toContain('NanoClaw Admin');
        });
    });

    describe('Route: GET /admin/api/health', () => {
        it('returns system health JSON', async () => {
            const req = createMockReq('GET', '/admin/api/health', {
                authorization: 'Bearer test-secret-token',
            });
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(200);
            expect(result.headers['Content-Type']).toContain('application/json');

            const data = JSON.parse(result.body);
            expect(data.overallStatus).toBe('healthy');
            expect(data.services).toHaveLength(2);
            expect(provider.getSystemHealth).toHaveBeenCalledOnce();
        });
    });

    describe('Route: GET /admin/api/whatsapp/status', () => {
        it('returns WhatsApp status with QR info', async () => {
            const req = createMockReq('GET', '/admin/api/whatsapp/status', {
                authorization: 'Bearer test-secret-token',
            });
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(200);
            const data = JSON.parse(result.body);
            expect(data.connected).toBe(true);
            expect(data.phoneNumber).toBe('+6591234567');
            expect(data.state).toBe('connected');
            expect(data.qr).toBeDefined();
            expect(data.qr.available).toBe(false);
        });
    });

    describe('Route: POST /admin/api/whatsapp/disconnect', () => {
        it('calls disconnect on provider', async () => {
            const req = createMockReq('POST', '/admin/api/whatsapp/disconnect', {
                authorization: 'Bearer test-secret-token',
            });
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(200);
            const data = JSON.parse(result.body);
            expect(data.success).toBe(true);
            expect(data.message).toBe('Disconnected');
            expect(provider.disconnectWhatsApp).toHaveBeenCalledOnce();
        });
    });

    describe('Route: POST /admin/api/whatsapp/reconnect', () => {
        it('calls reconnect on provider', async () => {
            const req = createMockReq('POST', '/admin/api/whatsapp/reconnect', {
                authorization: 'Bearer test-secret-token',
            });
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(200);
            const data = JSON.parse(result.body);
            expect(data.success).toBe(true);
            expect(provider.reconnectWhatsApp).toHaveBeenCalledOnce();
        });
    });

    describe('Route: GET /admin/api/containers', () => {
        it('returns container list', async () => {
            const req = createMockReq('GET', '/admin/api/containers', {
                authorization: 'Bearer test-secret-token',
            });
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(200);
            const data = JSON.parse(result.body);
            expect(data.total).toBe(2);
            expect(data.containers).toHaveLength(2);
            expect(data.containers[0].userId).toBe('user-001-hash');
        });
    });

    describe('Route: GET /admin/api/stats', () => {
        it('returns rate limiting stats', async () => {
            const req = createMockReq('GET', '/admin/api/stats', {
                authorization: 'Bearer test-secret-token',
            });
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(200);
            const data = JSON.parse(result.body);
            expect(data.globalMessagesPerMinute).toBe(5);
            expect(data.activeUsers).toBe(3);
        });
    });

    describe('Route: GET /admin/sse', () => {
        it('sets up SSE connection with correct headers', async () => {
            const req = createMockReq('GET', '/admin/sse', {
                authorization: 'Bearer test-secret-token',
            });
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(200);
            expect(result.headers['Content-Type']).toBe('text/event-stream');
            expect(result.headers['Cache-Control']).toBe('no-cache');
            expect(result.headers['Connection']).toBe('keep-alive');
            expect(result.body).toContain('event: connected');
        });
    });

    describe('Non-admin routes', () => {
        it('returns false for non-admin paths', async () => {
            const req = createMockReq('GET', '/health');
            const { res } = createMockRes();

            const handled = await handleAdminRequest(req, res);

            expect(handled).toBe(false);
        });

        it('returns false for webhook paths', async () => {
            const req = createMockReq('POST', '/webhook/telegram');
            const { res } = createMockRes();

            const handled = await handleAdminRequest(req, res);

            expect(handled).toBe(false);
        });
    });

    describe('Unknown admin routes', () => {
        it('returns 404 for unknown /admin sub-paths', async () => {
            const req = createMockReq('GET', '/admin/unknown', {
                authorization: 'Bearer test-secret-token',
            });
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(404);
            expect(JSON.parse(result.body)).toEqual({ error: 'Not found' });
        });
    });

    describe('Error handling', () => {
        it('returns 500 when provider throws', async () => {
            (provider.getSystemHealth as ReturnType<typeof vi.fn>).mockRejectedValue(
                new Error('Redis connection lost'),
            );

            const req = createMockReq('GET', '/admin/api/health', {
                authorization: 'Bearer test-secret-token',
            });
            const { res, result } = createMockRes();

            await handleAdminRequest(req, res);

            expect(result.statusCode).toBe(500);
            expect(JSON.parse(result.body)).toEqual({ error: 'Internal server error' });
        });
    });

    describe('HTML template', () => {
        it('returns valid HTML with required sections', () => {
            const html = getDashboardHtml();

            expect(html).toContain('<!DOCTYPE html>');
            expect(html).toContain('NanoClaw Admin');
            expect(html).toContain('WhatsApp Connection');
            expect(html).toContain('System Health');
            expect(html).toContain('Active Containers');
            expect(html).toContain('Rate Limiting');
            expect(html).toContain('Quick Actions');
        });

        it('includes SSE connection logic', () => {
            const html = getDashboardHtml();

            expect(html).toContain('EventSource');
            expect(html).toContain('/admin/sse');
        });

        it('includes QR code display logic', () => {
            const html = getDashboardHtml();

            expect(html).toContain('qr-image');
            expect(html).toContain('qrDataUrl');
        });
    });

    describe('Lifecycle', () => {
        it('can be initialized and shut down multiple times', () => {
            shutdownAdminDashboard();
            initAdminDashboard({ token: 'token1', provider });
            shutdownAdminDashboard();
            initAdminDashboard({ token: 'token2', provider });
            shutdownAdminDashboard();

            // Should not throw
            expect(true).toBe(true);
        });
    });
});
