/**
 * Morning briefing: sent at 07:00 SGT (23:00 UTC) to all users who have
 * completed onboarding. Fetches calendar events + unread emails for users
 * with Google or Microsoft connected, then generates a personalised digest
 * via the sub-agent and delivers over WhatsApp.
 */

import { log } from '../log.js';

let briefingTimer: ReturnType<typeof setTimeout> | null = null;

function nextRunMs(): number {
    const now = new Date();
    // 07:00 SGT = 23:00 UTC
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 0, 0, 0));
    if (target.getTime() <= now.getTime()) {
        target.setUTCDate(target.getUTCDate() + 1);
    }
    return target.getTime() - now.getTime();
}

export function scheduleMorningBriefing(): void {
    const delay = nextRunMs();
    log.info('Morning briefing scheduled', { nextRunIn: `${Math.round(delay / 60000)}min` });
    briefingTimer = setTimeout(() => {
        void runBriefing();
        scheduleMorningBriefing(); // reschedule for next day
    }, delay);
}

export function stopMorningBriefing(): void {
    if (briefingTimer) { clearTimeout(briefingTimer); briefingTimer = null; }
}

async function getRedis(): Promise<import('ioredis').Redis | null> {
    try {
        const { getCloudServices } = await import('./bootstrap.js');
        return getCloudServices()?.redis ?? null;
    } catch { return null; }
}

async function refreshGoogleToken(tokens: Record<string, unknown>): Promise<Record<string, unknown>> {
    const refreshToken = tokens.refresh_token as string;
    if (!refreshToken) return tokens;
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            refresh_token: refreshToken,
            client_id: process.env.GOOGLE_CLIENT_ID || '',
            client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
            grant_type: 'refresh_token',
        }).toString(),
    });
    if (!r.ok) return tokens;
    const fresh = await r.json() as Record<string, unknown>;
    return { ...tokens, ...fresh, refresh_token: refreshToken };
}

async function fetchGoogleCalendar(accessToken: string): Promise<string[]> {
    const now = new Date();
    const end = new Date(now.getTime() + 2 * 86400 * 1000); // next 48h
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${end.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=10`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return [];
    const data = await r.json() as { items?: Array<{ summary?: string; start?: { dateTime?: string; date?: string } }> };
    return (data.items || []).map(e => {
        const when = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Singapore' }) : 'all day';
        return `${when}: ${e.summary || 'Untitled'}`;
    });
}

async function fetchGmailUnread(accessToken: string): Promise<string[]> {
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=5', {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return [];
    const data = await r.json() as { messages?: Array<{ id: string }> };
    const msgs = data.messages || [];
    const subjects: string[] = [];
    for (const m of msgs.slice(0, 5)) {
        const mr = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!mr.ok) continue;
        const md = await mr.json() as { payload?: { headers?: Array<{ name: string; value: string }> } };
        const headers = md.payload?.headers || [];
        const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
        const from = headers.find(h => h.name === 'From')?.value || '';
        subjects.push(`"${subject}" from ${from.split('<')[0].trim()}`);
    }
    return subjects;
}

async function buildBriefingMessage(
    userName: string,
    calEvents: string[],
    unreadEmails: string[],
): Promise<string> {
    const day = new Date().toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Singapore' });
    const lines = [`Good morning${userName ? ', ' + userName : ''}! Here's your briefing for *${day}*:\n`];
    if (calEvents.length > 0) {
        lines.push('*Calendar*');
        calEvents.forEach(e => lines.push(`  \u2022 ${e}`));
    } else {
        lines.push('*Calendar:* No events today.');
    }
    if (unreadEmails.length > 0) {
        lines.push('\n*Unread emails*');
        unreadEmails.forEach(e => lines.push(`  \u2022 ${e}`));
    }
    lines.push('\nHave a great day! Type /help to see what I can do.');
    return lines.join('\n');
}

async function sendToUser(redis: import('ioredis').Redis, userId: string, message: string): Promise<void> {
    const payload = JSON.stringify({
        id: `briefing-${Date.now()}-${userId}`,
        userId,
        type: 'chat',
        payload: {
            content: message,
            platformId: `${userId}@s.whatsapp.net`,
            channelType: 'whatsapp',
            threadId: null,
        },
        timestamp: new Date().toISOString(),
    });
    await redis.lpush('queue:orchestrator:responses', payload);
}

async function runBriefing(): Promise<void> {
    log.info('Morning briefing: starting run');
    const redis = await getRedis();
    if (!redis) {
        log.warn('Morning briefing: no Redis, skipping');
        return;
    }
    try {
        // Find all users with google or microsoft tokens
        // Scan redis for oauth:tokens:*:google and oauth:tokens:*:microsoft
        const googleKeys = await redis.keys('oauth:tokens:*:google');
        const msKeys = await redis.keys('oauth:tokens:*:microsoft');
        const userTokens = new Map<string, { google?: Record<string, unknown>; microsoft?: Record<string, unknown> }>();
        for (const key of googleKeys) {
            const userId = key.split(':')[2];
            const raw = await redis.get(key);
            if (raw) {
                const existing = userTokens.get(userId) || {};
                userTokens.set(userId, { ...existing, google: JSON.parse(raw) });
            }
        }
        for (const key of msKeys) {
            const userId = key.split(':')[2];
            const raw = await redis.get(key);
            if (raw) {
                const existing = userTokens.get(userId) || {};
                userTokens.set(userId, { ...existing, microsoft: JSON.parse(raw) });
            }
        }

        log.info('Morning briefing: users with integrations', { count: userTokens.size });

        for (const [userId, tokens] of userTokens) {
            try {
                let calEvents: string[] = [];
                let unreadEmails: string[] = [];
                let userName = '';

                // Get user name from discovery state
                const discRaw = await redis.hgetall(`discovery:${userId}`);
                if (discRaw?.name) userName = discRaw.name;

                if (tokens.google) {
                    try {
                        const refreshed = await refreshGoogleToken(tokens.google);
                        // Update stored token if refreshed
                        await redis.set(`oauth:tokens:${userId}:google`, JSON.stringify(refreshed));
                        const accessToken = refreshed.access_token as string;
                        if (accessToken) {
                            calEvents = await fetchGoogleCalendar(accessToken);
                            unreadEmails = await fetchGmailUnread(accessToken);
                        }
                    } catch (err) {
                        log.warn('Morning briefing: Google fetch failed', { userId, err });
                    }
                }

                const message = await buildBriefingMessage(userName, calEvents, unreadEmails);
                await sendToUser(redis, userId, message);
                log.info('Morning briefing sent', { userId });
            } catch (err) {
                log.error('Morning briefing: failed for user', { userId, err });
            }
        }
        log.info('Morning briefing: run complete', { userCount: userTokens.size });
    } catch (err) {
        log.error('Morning briefing run error', { err });
    }
}
