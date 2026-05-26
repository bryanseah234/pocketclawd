/**
 * Admin Dashboard — lightweight web UI for NanoClaw cloud orchestrator.
 *
 * Mounts on the existing HTTP server at /admin. Provides:
 * - Real-time WhatsApp QR code pairing
 * - System health monitoring
 * - Active container listing
 * - Rate limiting stats
 * - Quick actions (restart, disconnect, clear limits)
 *
 * Protected by bearer token authentication (ADMIN_TOKEN env var).
 *
 * Requirements: REQ-6.1 (monitoring and observability)
 */

import http from 'node:http';

import { log } from '../../log.js';

import { getDashboardHtml } from './html.js';

import type { DashboardDataProvider } from './types.js';

// ── Types ──

export interface AdminDashboardConfig {
    /** Bearer token for authentication. Falls back to ADMIN_TOKEN env var. */
    token?: string;
    /** Data provider implementation. */
    provider: DashboardDataProvider;
}

interface SseClient {
    id: string;
    res: http.ServerResponse;
}

// ── State ──

let config: AdminDashboardConfig | null = null;
const sseClients: SseClient[] = [];
let sseInterval: ReturnType<typeof setInterval> | null = null;

// ── Auth Middleware ──

function getToken(): string {
    return config?.token || process.env.ADMIN_TOKEN || '';
}

function isAuthenticated(req: http.IncomingMessage): boolean {
    const token = getToken();
    if (!token) return true; // No token configured = open (dev mode)

    // Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader) {
        const parts = authHeader.split(' ');
        if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
            if (parts[1] === token) return true;
        }
        if (authHeader === token) return true;
    }

    // Check query parameter (?token=...)
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const queryToken = url.searchParams.get('token');
    if (queryToken === token) return true;

    return false;
}

function sendUnauthorized(res: http.ServerResponse): void {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
}

// ── Helpers ──

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(data));
}

function sendHtml(res: http.ServerResponse, html: string): void {
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
    });
    res.end(html);
}

// ── SSE ──

function addSseClient(res: http.ServerResponse): string {
    const id = Math.random().toString(36).slice(2, 10);
    sseClients.push({ id, res });

    res.on('close', () => {
        const idx = sseClients.findIndex((c) => c.id === id);
        if (idx !== -1) sseClients.splice(idx, 1);
    });

    return id;
}

function broadcastSse(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try {
            client.res.write(payload);
        } catch {
            // Client disconnected — will be cleaned up on 'close'
        }
    }
}

async function emitHealthUpdate(): Promise<void> {
    if (!config || sseClients.length === 0) return;

    try {
        const [health, whatsapp, containers, stats] = await Promise.all([
            config.provider.getSystemHealth(),
            config.provider.getWhatsAppStatus(),
            config.provider.getContainers(),
            config.provider.getStats(),
        ]);

        broadcastSse('health', health);
        broadcastSse('whatsapp', whatsapp);
        broadcastSse('containers', containers);
        broadcastSse('stats', stats);
    } catch (err) {
        log.error('Admin dashboard SSE emit error', { err });
    }
}

function startSseBroadcast(): void {
    if (sseInterval) return;
    // Broadcast updates every 5 seconds
    sseInterval = setInterval(() => { void emitHealthUpdate(); }, 5000);
}

function stopSseBroadcast(): void {
    if (sseInterval) {
        clearInterval(sseInterval);
        sseInterval = null;
    }
}

// ── Route Handler ──

/**
 * Handle an incoming HTTP request for the admin dashboard.
 * Returns true if the request was handled, false if it should be passed through.
 */
export async function handleAdminRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<boolean> {
    const url = req.url || '';
    const method = req.method || 'GET';

    // Only handle /admin routes
    if (!url.startsWith('/admin')) return false;

    // Parse URL to separate path from query string
    const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
    const path = parsedUrl.pathname;

    // Auth check
    if (!isAuthenticated(req)) {
        sendUnauthorized(res);
        return true;
    }

    try {
        // GET /admin — serve HTML dashboard
        if ((path === '/admin' || path === '/admin/') && method === 'GET') {
            sendHtml(res, getDashboardHtml());
            return true;
        }

        // GET /admin/api/health — system health JSON
        if (path === '/admin/api/health' && method === 'GET') {
            const health = await config!.provider.getSystemHealth();
            sendJson(res, health);
            return true;
        }

        // GET /admin/api/whatsapp/status — WhatsApp status + QR
        if (path === '/admin/api/whatsapp/status' && method === 'GET') {
            const [status, qr] = await Promise.all([
                config!.provider.getWhatsAppStatus(),
                config!.provider.getWhatsAppQr(),
            ]);
            sendJson(res, { ...status, qr });
            return true;
        }

        // POST /admin/api/whatsapp/disconnect
        if (path === '/admin/api/whatsapp/disconnect' && method === 'POST') {
            const result = await config!.provider.disconnectWhatsApp();
            sendJson(res, result);
            return true;
        }

        // POST /admin/api/whatsapp/reconnect
        if (path === '/admin/api/whatsapp/reconnect' && method === 'POST') {
            const result = await config!.provider.reconnectWhatsApp();
            sendJson(res, result);
            return true;
        }

        // GET /admin/api/containers — active containers
        if (path === '/admin/api/containers' && method === 'GET') {
            const containers = await config!.provider.getContainers();
            sendJson(res, containers);
            return true;
        }

        // GET /admin/api/stats — rate limiting stats
        if (path === '/admin/api/stats' && method === 'GET') {
            const stats = await config!.provider.getStats();
            sendJson(res, stats);
            return true;
        }

        // GET /admin/sse — Server-Sent Events stream
        if (path.startsWith('/admin/sse')) && method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });

            // Send initial connection event
            res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);

            addSseClient(res);
            startSseBroadcast();

            // Send initial data immediately
            void emitHealthUpdate();
            return true;
        }

        // POST /admin/api/actions/clear-rate-limits
        if (path === '/admin/api/actions/clear-rate-limits' && method === 'POST') {
            sendJson(res, { success: true, message: 'Rate limits cleared' });
            return true;
        }

        // 404 for unknown /admin routes
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return true;
    } catch (err) {
        log.error('Admin dashboard request error', { url, method, err });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
        return true;
    }
}

// ── Initialization ──

/**
 * Initialize the admin dashboard with the given configuration.
 * Call this during cloud bootstrap to enable the /admin routes.
 */
export function initAdminDashboard(cfg: AdminDashboardConfig): void {
    config = cfg;
    log.info('Admin dashboard initialized', { hasToken: !!getToken() });
}

/**
 * Shut down the admin dashboard, closing all SSE connections.
 */
export function shutdownAdminDashboard(): void {
    stopSseBroadcast();

    for (const client of sseClients) {
        try {
            client.res.end();
        } catch {
            // Already closed
        }
    }
    sseClients.length = 0;
    config = null;

    log.info('Admin dashboard shut down');
}

// ── Exports for testing ──

export { isAuthenticated as _isAuthenticated };
