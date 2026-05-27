/**
 * Clawd Landing Page — request handler.
 *
 * Serves the public marketing landing page at GET /.
 * No authentication required.
 *
 * Requirements: 1.1, 1.2, 12.1–12.3
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

    const html = getLandingPageHtml();
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
    });
    res.end(html);
    return true;
}
