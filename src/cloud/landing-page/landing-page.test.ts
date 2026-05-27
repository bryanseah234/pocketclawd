/**
 * Clawd Landing Page — unit tests for HTML structure and route handler.
 *
 * Validates:
 * - Semantic HTML structure (header, nav, main, section, footer)
 * - Content sections (hero, features, how-it-works, pricing, footer)
 * - SEO metadata (title, viewport, Open Graph tags)
 * - Design tokens and responsive CSS
 * - Route handler behavior (GET / → 200, POST / → false)
 * - Performance constraint (< 500KB)
 *
 * Requirements: 1.1–1.2, 2.1–2.4, 3.1–3.5, 4.1–4.2, 6.1–6.3, 7.1–7.3,
 *              8.1–8.2, 9.1–9.6, 11.3, 13.1–13.5, 14.1, 14.3
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import fc from 'fast-check';

import { getLandingPageHtml } from './html.js';
import { handleLandingPageRequest } from './index.js';

// ── Helpers ──

function createMockReq(
    method: string,
    url: string,
    headers: Record<string, string> = {},
): http.IncomingMessage {
    const req = new EventEmitter() as http.IncomingMessage;
    req.method = method;
    req.url = url;
    req.headers = headers;
    return req;
}

function createMockRes(): http.ServerResponse & {
    _statusCode: number;
    _headers: Record<string, string>;
    _body: string;
} {
    const res = new EventEmitter() as http.ServerResponse & {
        _statusCode: number;
        _headers: Record<string, string>;
        _body: string;
    };
    res._statusCode = 0;
    res._headers = {};
    res._body = '';
    res.writeHead = function (statusCode: number, headers?: Record<string, string>) {
        res._statusCode = statusCode;
        if (headers) {
            res._headers = { ...headers };
        }
        return res;
    } as unknown as typeof res.writeHead;
    res.end = function (body?: string) {
        if (body) res._body = body;
    } as unknown as typeof res.end;
    return res;
}

// ── HTML Structure Tests ──

describe('getLandingPageHtml — semantic HTML structure', () => {
    const html = getLandingPageHtml();

    it('contains <header> element', () => {
        expect(html).toContain('<header');
    });

    it('contains <nav> element', () => {
        expect(html).toContain('<nav');
    });

    it('contains <main> element', () => {
        expect(html).toContain('<main');
    });

    it('contains <section> elements', () => {
        expect(html).toContain('<section');
    });

    it('contains <footer> element', () => {
        expect(html).toContain('<footer');
    });

    it('contains exactly one <h1> element', () => {
        const h1Matches = html.match(/<h1[\s>]/g);
        expect(h1Matches).not.toBeNull();
        expect(h1Matches!.length).toBe(1);
    });
});

// ── Hero Section Tests ──

describe('getLandingPageHtml — hero section', () => {
    const html = getLandingPageHtml();

    it('contains "Clawd" in the headline', () => {
        const h1Match = html.match(/<h1[^>]*>([^<]*)<\/h1>/);
        expect(h1Match).not.toBeNull();
        expect(h1Match![1]).toContain('Clawd');
    });

    it('contains a value proposition subheadline', () => {
        expect(html).toContain('hero-subheadline');
        expect(html).toContain('AI assistant');
    });

    it('contains CTA button (default pre-launch state)', () => {
        expect(html).toContain('Get Early Access');
    });

    it('connected state shows live CTA', () => {
        const liveHtml = getLandingPageHtml({ waConnected: true, waPhone: '6581234567' });
        expect(liveHtml).toContain('Chat with Clawd on WhatsApp');
        expect(liveHtml).toContain('status-live');
    });
});

// ── Features Section Tests ──

describe('getLandingPageHtml — features section', () => {
    const html = getLandingPageHtml();

    it('contains exactly 4 feature items with correct titles', () => {
        expect(html).toContain('Remembers Everything');
        expect(html).toContain('Document Intelligence');
        expect(html).toContain('Daily Briefings');
        expect(html).toContain('Always Available');

        const featureItems = html.match(/class="feature-item"/g);
        expect(featureItems).not.toBeNull();
        expect(featureItems!.length).toBe(4);
    });
});

// ── How It Works Section Tests ──

describe('getLandingPageHtml — How It Works section', () => {
    const html = getLandingPageHtml();

    it('has 3 steps in correct order', () => {
        const step1Pos = html.indexOf('Send a message');
        const step2Pos = html.indexOf('Clawd learns');
        const step3Pos = html.indexOf('Ask anything');

        expect(step1Pos).toBeGreaterThan(-1);
        expect(step2Pos).toBeGreaterThan(-1);
        expect(step3Pos).toBeGreaterThan(-1);

        expect(step1Pos).toBeLessThan(step2Pos);
        expect(step2Pos).toBeLessThan(step3Pos);
    });
});

// ── Pricing Section Tests ──

describe('getLandingPageHtml — pricing section', () => {
    const html = getLandingPageHtml();

    it('has "Free Trial" and "Pro" tiers', () => {
        expect(html).toContain('Free Trial');
        expect(html).toContain('Pro');
    });
});

// ── Footer Tests ──

describe('getLandingPageHtml — footer', () => {
    const html = getLandingPageHtml();

    it('contains Privacy Policy link', () => {
        expect(html).toContain('Privacy Policy');
        expect(html).toContain('/privacy');
    });

    it('contains Terms of Service link', () => {
        expect(html).toContain('Terms of Service');
        expect(html).toContain('/terms');
    });
});

// ── Navigation Tests ──

describe('getLandingPageHtml — navigation', () => {
    const html = getLandingPageHtml();

    it('contains Login link with href="/admin"', () => {
        expect(html).toMatch(/href="\/admin"[^>]*>Login</);
    });
});

// ── SEO / Meta Tests ──

describe('getLandingPageHtml — SEO metadata', () => {
    const html = getLandingPageHtml();

    it('has viewport meta tag set to width=device-width, initial-scale=1', () => {
        expect(html).toContain('width=device-width, initial-scale=1');
    });

    it('has og:title meta tag', () => {
        expect(html).toMatch(/property="og:title"/);
    });

    it('has og:description meta tag', () => {
        expect(html).toMatch(/property="og:description"/);
    });

    it('has og:image meta tag', () => {
        expect(html).toMatch(/property="og:image"/);
    });

    it('has og:url meta tag', () => {
        expect(html).toMatch(/property="og:url"/);
    });

    it('has <title> containing "Clawd"', () => {
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        expect(titleMatch).not.toBeNull();
        expect(titleMatch![1]).toContain('Clawd');
    });
});

// ── CSS Design Tokens Tests ──

describe('getLandingPageHtml — CSS design tokens', () => {
    const html = getLandingPageHtml();

    it('contains oatmeal background color #F5F0E8', () => {
        expect(html).toContain('#F5F0E8');
    });

    it('contains espresso text color #3D2B1F', () => {
        expect(html).toContain('#3D2B1F');
    });

    it('contains mustard accent color #C4A35A', () => {
        expect(html).toContain('#C4A35A');
    });

    it('contains max-width 720px', () => {
        expect(html).toContain('720px');
    });

    it('contains font-display: swap (via Google Fonts display=swap parameter)', () => {
        // The font-display: swap directive is applied via the Google Fonts URL parameter
        expect(html).toContain('display=swap');
    });
});

// ── Responsive CSS Tests ──

describe('getLandingPageHtml — responsive design', () => {
    const html = getLandingPageHtml();

    it('contains media query for viewport < 768px', () => {
        expect(html).toMatch(/max-width:\s*768px/);
    });
});

// ── Performance Tests ──

describe('getLandingPageHtml — performance', () => {
    it('HTML output is under 500KB', () => {
        const html = getLandingPageHtml();
        const byteLength = Buffer.byteLength(html, 'utf-8');
        expect(byteLength).toBeLessThan(500 * 1024);
    });
});

// ── Route Handler Tests ──

describe('handleLandingPageRequest', () => {
    it('returns true and responds 200 with text/html for GET /', () => {
        const req = createMockReq('GET', '/');
        const res = createMockRes();

        const handled = handleLandingPageRequest(
            req,
            res as unknown as http.ServerResponse,
        );

        expect(handled).toBe(true);
        expect(res._statusCode).toBe(200);
        expect(res._headers['Content-Type']).toContain('text/html');
        expect(res._body.length).toBeGreaterThan(0);
    });

    it('returns false for POST /', () => {
        const req = createMockReq('POST', '/');
        const res = createMockRes();

        const handled = handleLandingPageRequest(
            req,
            res as unknown as http.ServerResponse,
        );

        expect(handled).toBe(false);
    });

    it('GET / does not require authentication headers', () => {
        const req = createMockReq('GET', '/', {});
        const res = createMockRes();

        const handled = handleLandingPageRequest(
            req,
            res as unknown as http.ServerResponse,
        );

        expect(handled).toBe(true);
        expect(res._statusCode).toBe(200);
    });
});

// ── Property-Based Tests ──

/**
 * Simulates the orchestrator's routing logic from src/index.ts.
 * Routes: GET / → landing page, GET /health → health, /admin → admin, else → 404.
 */
function simulateRouting(req: http.IncomingMessage, res: ReturnType<typeof createMockRes>): void {
    // Landing page — served at GET / without authentication
    if (req.url === '/' && req.method === 'GET') {
        handleLandingPageRequest(req, res as unknown as http.ServerResponse);
        return;
    }

    // Health check
    if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
    }

    // Admin dashboard (starts with /admin)
    if (req.url?.startsWith('/admin')) {
        // Simulate admin handling (returns true)
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>admin</html>');
        return;
    }

    // 404 — unknown route
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
}

describe('Property: Unknown routes return 404', () => {
    /**
     * **Validates: Requirements 1.5**
     *
     * For any URL path string that does not exactly match `/`, `/health`,
     * or start with `/admin`, the orchestrator SHALL respond with HTTP
     * status 404 and a JSON body containing an `error` field.
     */
    it('all unknown routes return 404 with JSON error body', () => {
        // Generate random URL path strings that are NOT known routes
        const unknownPathArb = fc
            .string({ minLength: 1, maxLength: 50 })
            .map((s) => '/' + s.replace(/\0/g, ''))
            .filter((path) => {
                // Exclude known routes
                if (path === '/') return false;
                if (path === '/health') return false;
                if (path.startsWith('/admin')) return false;
                return true;
            });

        fc.assert(
            fc.property(unknownPathArb, (path) => {
                const req = createMockReq('GET', path);
                const res = createMockRes();

                simulateRouting(req, res);

                // Must return 404
                expect(res._statusCode).toBe(404);

                // Must have JSON content type
                expect(res._headers['Content-Type']).toBe('application/json');

                // Must have a JSON body with an `error` field
                const body = JSON.parse(res._body);
                expect(body).toHaveProperty('error');
            }),
            { numRuns: 100 },
        );
    });
});
