/**
 * OAuth 2.0 integration for Google and Microsoft.
 *
 * Endpoints:
 *   GET /oauth/google?state=<token>
 *   GET /oauth/google/callback?code=&state=
 *   GET /oauth/microsoft?state=<token>
 *   GET /oauth/microsoft/callback?code=&state=
 *
 * Env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 *           MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
 *           PUBLIC_BASE_URL (e.g. http://3.0.132.150:3000)
 */

import * as http from 'node:http';
import { log } from '../../log.js';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://3.0.132.150:3000';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || '';
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || '';

const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/gmail.readonly',
    'openid', 'email',
].join(' ');

const MICROSOFT_SCOPES = 'offline_access Calendars.Read Mail.Read User.Read';

function sendHtml(res: http.ServerResponse, title: string, body: string, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;text-align:center}
h2{color:#2d2d2d}.ok{color:#2e7d32}.err{color:#c62828}p{color:#555;line-height:1.6}</style>
</head><body>${body}</body></html>`);
}

async function getRedis(): Promise<import('ioredis').Redis | null> {
    try {
        const { getCloudServices } = await import('../bootstrap.js');
        return getCloudServices()?.redis ?? null;
    } catch { return null; }
}

async function notifyUser(userId: string, msg: string): Promise<void> {
    try {
        const redis = await getRedis();
        if (!redis) return;
        // Derive channelType + platformId from userId prefix (wa: / tg: / legacy bare)
        let channelType: string;
        let platformId: string;
        if (userId.startsWith('tg:')) {
            channelType = 'telegram';
            platformId = userId.slice(3); // raw chat_id
        } else {
            channelType = 'whatsapp';
            const phone = userId.startsWith('wa:') ? userId.slice(3) : userId;
            platformId = `${phone}@s.whatsapp.net`;
        }
        const payload = JSON.stringify({
            id: `oauth-notify-${Date.now()}`,
            userId,
            type: 'chat',
            payload: {
                content: msg,
                platformId,
                channelType,
                threadId: null,
            },
            timestamp: new Date().toISOString(),
        });
        await redis.lpush('queue:orchestrator:responses', payload);
    } catch (err) {
        log.error('OAuth: notify user failed', { userId, err });
    }
}

async function storeTokens(userId: string, service: string, tokens: Record<string, unknown>): Promise<void> {
    const redis = await getRedis();
    if (!redis) return;
    await redis.set(`oauth:tokens:${userId}:${service}`, JSON.stringify(tokens));
    await redis.lpush('queue:orchestrator:data_gateway', JSON.stringify({
        action: 'put_user_preference',
        user_id: userId,
        request_id: `oauth-${Date.now()}`,
        preferences: {
            [`${service}_tokens`]: JSON.stringify(tokens),
            [`${service}_connected`]: 'true',
        },
    }));
}

async function exchangeGoogle(code: string, userId: string): Promise<void> {
    const redirect = `${PUBLIC_BASE_URL}/oauth/google/callback`;
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }).toString(),
    });
    if (!r.ok) throw new Error(`Google token exchange: ${r.status} ${(await r.text()).slice(0,200)}`);
    await storeTokens(userId, 'google', await r.json() as Record<string, unknown>);
}

async function exchangeMicrosoft(code: string, userId: string): Promise<void> {
    const redirect = `${PUBLIC_BASE_URL}/oauth/microsoft/callback`;
    const r = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: MICROSOFT_CLIENT_ID, client_secret: MICROSOFT_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code', scope: MICROSOFT_SCOPES }).toString(),
    });
    if (!r.ok) throw new Error(`Microsoft token exchange: ${r.status} ${(await r.text()).slice(0,200)}`);
    await storeTokens(userId, 'microsoft', await r.json() as Record<string, unknown>);
}

export async function handleOAuthRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<boolean> {
    const rawUrl = req.url || '';
    const parsed = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
    const path = parsed.pathname;

    // Google initiation
    if (path === '/oauth/google' && req.method === 'GET') {
        if (!GOOGLE_CLIENT_ID) { sendHtml(res, 'Not configured', '<h2 class="err">Google OAuth not configured</h2><p>Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.</p>', 503); return true; }
        const state = parsed.searchParams.get('state') || '';
        if (!state) { sendHtml(res, 'Bad link', '<h2 class="err">Invalid link</h2><p>Type /connect google in WhatsApp for a fresh link.</p>', 400); return true; }
        const redirect = encodeURIComponent(`${PUBLIC_BASE_URL}/oauth/google/callback`);
        const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${redirect}&response_type=code&scope=${encodeURIComponent(GOOGLE_SCOPES)}&access_type=offline&prompt=consent&state=${state}`;
        res.writeHead(302, { Location: url }); res.end();
        return true;
    }

    // Google callback
    if (path === '/oauth/google/callback' && req.method === 'GET') {
        const code = parsed.searchParams.get('code') || '';
        const state = parsed.searchParams.get('state') || '';
        const error = parsed.searchParams.get('error');
        if (error || !code) { sendHtml(res, 'Failed', `<h2 class="err">Auth failed</h2><p>${error || 'No code'}</p>`, 400); return true; }
        try {
            const redis = await getRedis();
            const raw = redis ? await redis.get(`oauth:state:${state}`) : null;
            if (!raw) { sendHtml(res, 'Expired', '<h2 class="err">Link expired</h2><p>Type /connect google for a new link.</p>', 400); return true; }
            const { userId } = JSON.parse(raw) as { userId: string };
            await redis!.del(`oauth:state:${state}`);
            await exchangeGoogle(code, userId);
            await notifyUser(userId, '\u2705 *Google connected!*\n\nCalendar + Gmail linked. Morning briefings now include your events and unread emails.\n\nType /help to see all commands.');
            sendHtml(res, 'Connected', '<h2 class="ok">\u2713 Google connected</h2><p>You can close this tab. Clawd will confirm on WhatsApp.</p>');
        } catch (err) {
            log.error('OAuth Google callback error', { err });
            sendHtml(res, 'Error', '<h2 class="err">Something went wrong</h2><p>Try /connect google again.</p>', 500);
        }
        return true;
    }

    // Microsoft initiation
    if (path === '/oauth/microsoft' && req.method === 'GET') {
        if (!MICROSOFT_CLIENT_ID) { sendHtml(res, 'Not configured', '<h2 class="err">Microsoft OAuth not configured</h2><p>Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.</p>', 503); return true; }
        const state = parsed.searchParams.get('state') || '';
        if (!state) { sendHtml(res, 'Bad link', '<h2 class="err">Invalid link</h2><p>Type /connect microsoft in WhatsApp for a fresh link.</p>', 400); return true; }
        const redirect = encodeURIComponent(`${PUBLIC_BASE_URL}/oauth/microsoft/callback`);
        const url = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${MICROSOFT_CLIENT_ID}&redirect_uri=${redirect}&response_type=code&scope=${encodeURIComponent(MICROSOFT_SCOPES)}&state=${state}`;
        res.writeHead(302, { Location: url }); res.end();
        return true;
    }

    // Microsoft callback
    if (path === '/oauth/microsoft/callback' && req.method === 'GET') {
        const code = parsed.searchParams.get('code') || '';
        const state = parsed.searchParams.get('state') || '';
        const error = parsed.searchParams.get('error');
        if (error || !code) { sendHtml(res, 'Failed', `<h2 class="err">Auth failed</h2><p>${error || 'No code'}</p>`, 400); return true; }
        try {
            const redis = await getRedis();
            const raw = redis ? await redis.get(`oauth:state:${state}`) : null;
            if (!raw) { sendHtml(res, 'Expired', '<h2 class="err">Link expired</h2><p>Type /connect microsoft for a new link.</p>', 400); return true; }
            const { userId } = JSON.parse(raw) as { userId: string };
            await redis!.del(`oauth:state:${state}`);
            await exchangeMicrosoft(code, userId);
            await notifyUser(userId, '\u2705 *Microsoft connected!*\n\nOutlook + Calendar linked. Morning briefings now include your events and unread emails.\n\nType /help to see all commands.');
            sendHtml(res, 'Connected', '<h2 class="ok">\u2713 Microsoft connected</h2><p>You can close this tab. Clawd will confirm on WhatsApp.</p>');
        } catch (err) {
            log.error('OAuth Microsoft callback error', { err });
            sendHtml(res, 'Error', '<h2 class="err">Something went wrong</h2><p>Try /connect microsoft again.</p>', 500);
        }
        return true;
    }

    return false;
}
