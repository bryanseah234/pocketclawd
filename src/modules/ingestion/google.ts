/**
 * PocketClaw — Google ingestion (Gmail / Calendar / Contacts) — PRD §7.9.1
 *
 * OAuth2 (Desktop app) → token cached at `~/.pocketclaw/secrets/google_token.json`.
 * Scopes: gmail.readonly, calendar.readonly, contacts.readonly.
 *
 * The googleapis SDK is loaded lazily so this file can compile before
 * `pnpm install` is run. Calls throw on missing creds (caller catches).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CloudIngester, Fact } from './types.js';
import { stripHtml } from './types.js';

const SECRETS_DIR =
  process.env.POCKETCLAW_SECRETS_DIR ??
  path.join(os.homedir(), '.pocketclaw', 'secrets');
const TOKEN_PATH = path.join(SECRETS_DIR, 'google_token.json');
const CREDENTIALS_PATH = path.join(SECRETS_DIR, 'google_credentials.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
];

/**
 * Auth manager — wraps googleapis OAuth2Client. Lazy import keeps build
 * green before deps are installed.
 */
export class GoogleAuthManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private oauth2Client: any = null;

  async ensure(): Promise<void> {
    if (this.oauth2Client) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let google: any;
    try {
      // @ts-expect-error optional dep
      google = (await import('googleapis')).google;
    } catch {
      throw new Error(
        'googleapis package not installed. Run `pnpm install googleapis@latest`.',
      );
    }

    const credsRaw = await fs.readFile(CREDENTIALS_PATH, 'utf8').catch(() => null);
    if (!credsRaw) {
      throw new Error(
        `Google credentials missing at ${CREDENTIALS_PATH}. Run /auth google.`,
      );
    }
    const creds = JSON.parse(credsRaw);
    const installed = creds.installed ?? creds.web ?? creds;

    this.oauth2Client = new google.auth.OAuth2(
      installed.client_id ?? process.env.GOOGLE_CLIENT_ID,
      installed.client_secret ?? process.env.GOOGLE_CLIENT_SECRET,
      installed.redirect_uris?.[0] ?? 'http://localhost',
    );

    const tokenRaw = await fs.readFile(TOKEN_PATH, 'utf8').catch(() => null);
    if (tokenRaw) {
      this.oauth2Client.setCredentials(JSON.parse(tokenRaw));
    } else {
      throw new Error(
        `Google token missing at ${TOKEN_PATH}. Run /auth google to start OAuth.`,
      );
    }
  }

  async client(): Promise<unknown> {
    await this.ensure();
    return this.oauth2Client;
  }
}

const auth = new GoogleAuthManager();

/** Gmail — last-N-day messages. */
export class GmailIngester implements CloudIngester {
  readonly source = 'gmail';

  async fetch(since: Date): Promise<{ facts: Fact[]; errors: string[] }> {
    const errors: string[] = [];
    const facts: Fact[] = [];

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const google = (await import('googleapis' as string)) as any;
      const gmail = google.google.gmail({ version: 'v1', auth: await auth.client() });

      const epochSec = Math.floor(since.getTime() / 1000);
      const list = await gmail.users.messages.list({
        userId: 'me',
        q: `after:${epochSec}`,
        maxResults: 50,
      });

      const ids = list.data.messages ?? [];
      for (const m of ids) {
        try {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: m.id,
            format: 'full',
          });
          const headers = detail.data.payload?.headers ?? [];
          const get = (n: string) =>
            headers.find((h: { name: string }) => h.name?.toLowerCase() === n.toLowerCase())
              ?.value ?? '';
          const subject = get('Subject');
          const from = get('From');
          const date = get('Date');
          const body = stripHtml(extractBody(detail.data.payload) ?? '');

          facts.push({
            text: `Email from ${from} subject "${subject}" on ${date}: ${body.slice(0, 500)}`,
            source: 'gmail',
            sourceId: detail.data.id ?? m.id,
            link: `https://mail.google.com/mail/u/0/#all/${detail.data.id ?? m.id}`,
            occurredAt: new Date(date || since),
            meta: { threadId: detail.data.threadId ?? '' },
          });
        } catch (e) {
          errors.push(`gmail message ${m.id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      errors.push(`gmail list: ${(e as Error).message}`);
    }

    return { facts, errors };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBody(payload: any): string {
  if (!payload) return '';
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
    }
    // fallback: any nested body
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return '';
}

/** Google Calendar events from `since` → now+7 days. */
export class GoogleCalendarIngester implements CloudIngester {
  readonly source = 'google-calendar';

  async fetch(since: Date): Promise<{ facts: Fact[]; errors: string[] }> {
    const errors: string[] = [];
    const facts: Fact[] = [];

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const google = (await import('googleapis' as string)) as any;
      const cal = google.google.calendar({ version: 'v3', auth: await auth.client() });

      const timeMax = new Date();
      timeMax.setDate(timeMax.getDate() + 7);

      const list = await cal.events.list({
        calendarId: 'primary',
        timeMin: since.toISOString(),
        timeMax: timeMax.toISOString(),
        maxResults: 100,
        singleEvents: true,
        orderBy: 'startTime',
      });

      for (const ev of list.data.items ?? []) {
        const start = ev.start?.dateTime ?? ev.start?.date ?? '';
        const end = ev.end?.dateTime ?? ev.end?.date ?? '';
        const attendees = (ev.attendees ?? [])
          .map((a: { email?: string; displayName?: string }) => a.displayName ?? a.email)
          .filter(Boolean)
          .join(', ');
        facts.push({
          text: `Calendar event "${ev.summary ?? '(no title)'}" ${start}–${end} ${
            ev.location ? `at ${ev.location}` : ''
          } ${attendees ? `with ${attendees}` : ''}`.trim(),
          source: 'google-calendar',
          sourceId: ev.id ?? '',
          link: ev.htmlLink ?? undefined,
          occurredAt: start ? new Date(start) : undefined,
        });
      }
    } catch (e) {
      errors.push(`google-calendar: ${(e as Error).message}`);
    }

    return { facts, errors };
  }
}

/** Google Contacts via People API. */
export class GoogleContactsIngester implements CloudIngester {
  readonly source = 'google-contacts';

  async fetch(_since: Date): Promise<{ facts: Fact[]; errors: string[] }> {
    const errors: string[] = [];
    const facts: Fact[] = [];

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const google = (await import('googleapis' as string)) as any;
      const people = google.google.people({ version: 'v1', auth: await auth.client() });

      const list = await people.people.connections.list({
        resourceName: 'people/me',
        personFields: 'names,emailAddresses,phoneNumbers,organizations',
        pageSize: 200,
      });

      for (const p of list.data.connections ?? []) {
        const name = p.names?.[0]?.displayName ?? '';
        const emails = (p.emailAddresses ?? [])
          .map((e: { value?: string }) => e.value)
          .filter(Boolean)
          .join(', ');
        const phones = (p.phoneNumbers ?? [])
          .map((n: { value?: string }) => n.value)
          .filter(Boolean)
          .join(', ');
        const org = p.organizations?.[0];
        const orgPart = org ? `${org.title ?? ''} at ${org.name ?? ''}`.trim() : '';

        if (!name && !emails && !phones) continue;

        facts.push({
          text: `Contact ${name}${emails ? ` <${emails}>` : ''}${phones ? `, phone ${phones}` : ''}${orgPart ? `, ${orgPart}` : ''}`,
          source: 'google-contacts',
          sourceId: p.resourceName,
        });
      }
    } catch (e) {
      errors.push(`google-contacts: ${(e as Error).message}`);
    }

    return { facts, errors };
  }
}

export const googleIngesters: CloudIngester[] = [
  new GmailIngester(),
  new GoogleCalendarIngester(),
  new GoogleContactsIngester(),
];

export { SCOPES as GOOGLE_SCOPES };
