/**
 * Public WhatsApp state endpoint — GET /api/wa-state (JSON one-shot)
 * and GET /api/wa-state/stream (Server-Sent Events live updates) (A4).
 * No auth required. Called by src/static/landing.html on load.
 */
import http from 'node:http';

interface WaStateMin { status: string; phoneNumber?: string | null; }
let _provider: (() => WaStateMin) | null = null;

// SSE broadcast registry — keyed by client id.
interface SseClient { id: string; res: http.ServerResponse; }
const _sseClients: SseClient[] = [];

export function registerWaStateProvider(
    fn: () => WaStateMin,
): void {
    _provider = fn;
}

function _formatPayload(): { connected: boolean; phone: string | null } {
    const state = _provider?.() ?? { status: 'unknown' };
    const connected = state.status === 'connected';
    const phone = connected && state.phoneNumber
        ? state.phoneNumber.split('@')[0]
        : null;
    return { connected, phone };
}

/**
 * Push a wa-state update to every connected SSE client. Called by the host
 * whenever the WhatsApp bridge fires its 'connection.update' or
 * 'creds.update' events. Cheap (no JSON parse, no DB hit).
 */
export function broadcastWaStateChange(): void {
    if (_sseClients.length === 0) return;
    const payload = _formatPayload();
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of _sseClients) {
        try { c.res.write(data); } catch { /* dead connection — clean up below */ }
    }
}

export function handleWaStateRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): boolean {
    // SSE stream: GET /api/wa-state/stream
    if (req.url === '/api/wa-state/stream' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'X-Accel-Buffering': 'no', // disable proxy buffering
        });
        const id = Math.random().toString(36).slice(2);
        _sseClients.push({ id, res });
        // Initial snapshot so clients don't have to fetch separately.
        res.write(`event: snapshot\ndata: ${JSON.stringify(_formatPayload())}\n\n`);
        // Heartbeat every 25s so proxies don't kill idle connections.
        const heartbeat = setInterval(() => {
            try { res.write(`: heartbeat\n\n`); }
            catch { /* dead — cleaned up below */ }
        }, 25000);
        const cleanup = () => {
            clearInterval(heartbeat);
            const idx = _sseClients.findIndex(c => c.id === id);
            if (idx !== -1) _sseClients.splice(idx, 1);
        };
        req.on('close', cleanup);
        req.on('error', cleanup);
        res.on('close', cleanup);
        return true;
    }

    // One-shot JSON: GET /api/wa-state
    if (req.url !== '/api/wa-state' || req.method !== 'GET') return false;

    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(_formatPayload()));
    return true;
}
