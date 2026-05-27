/**
 * Public WhatsApp state endpoint -- GET /api/wa-state
 * No auth required. Called by src/static/landing.html on load.
 */
import http from 'node:http';

let _provider: (() => { status: string; phoneNumber?: string }) | null = null;

export function registerWaStateProvider(
    fn: () => { status: string; phoneNumber?: string },
): void {
    _provider = fn;
}

export function handleWaStateRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): boolean {
    if (req.url !== '/api/wa-state' || req.method !== 'GET') return false;

    const state = _provider?.() ?? { status: 'unknown' };
    const connected = state.status === 'connected';
    const phone = connected && state.phoneNumber
        ? state.phoneNumber.split('@')[0]
        : null;

    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ connected, phone }));
    return true;
}
