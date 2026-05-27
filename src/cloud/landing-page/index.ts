/**
 * Clawd Landing Page — request handler.
 *
 * Serves the public marketing landing page at GET /.
 * No authentication required.
 *
 * Passes the live WhatsApp phone number (if connected) so the landing page
 * CTA links to the real number. Falls back to the default placeholder.
 */

import http from 'node:http';

import { getLandingPageHtml } from './html.js';

/**
 * Handle GET / requests by serving the landing page HTML.
 * Returns true if the request was handled, false otherwise.
 */
export function handleLandingPageRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): boolean {
    if (req.url !== '/' || req.method !== 'GET') {
        return false;
    }

    // Pull live WA state from the bridge if available
    const bridge = (globalThis as any).__nanoclaw_wa_bridge as {
        getWhatsAppState?: () => { connected: boolean; phone?: string };
    } | undefined;

    let waPhone: string | undefined;
    let waConnected = false;

    if (bridge?.getWhatsAppState) {
        const state = bridge.getWhatsAppState();
        waConnected = state.connected;
        if (state.connected && state.phone) {
            // phone is JID format like "6581234567@s.whatsapp.net" — extract digits
            waPhone = state.phone.split('@')[0];
        }
    }

    const html = getLandingPageHtml({ waPhone, waConnected });
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
    });
    res.end(html);
    return true;
}
