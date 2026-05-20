/**
 * PocketClaw — Microsoft 365 ingestion (Outlook Mail / Calendar / Contacts) — PRD §7.9.2
 *
 * Auth: MSAL device-code flow. Token cached at
 * `~/.pocketclaw/secrets/ms_token.json`.
 * Permissions required: Mail.Read, Calendars.Read, Contacts.Read.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CloudIngester, Fact } from './types.js';
import { stripHtml } from './types.js';

const SECRETS_DIR =
  process.env.POCKETCLAW_SECRETS_DIR ??
  path.join(os.homedir(), '.pocketclaw', 'secrets');
const MS_TOKEN_PATH = path.join(SECRETS_DIR, 'ms_token.json');
const MS_SCOPES = ['Mail.Read', 'Calendars.Read', 'Contacts.Read'];
const MS_GRAPH = 'https://graph.microsoft.com/v1.0';

export class MicrosoftAuthManager {
  private accessToken: string | null = null;
  private expiresAt = 0;

  async ensure(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) {
      return this.accessToken;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let msal: any;
    try {
      // @ts-expect-error optional dep
      msal = await import('@azure/msal-node');
    } catch {
      throw new Error(
        '@azure/msal-node not installed. Run `pnpm install @azure/msal-node`.',
      );
    }

    const clientId = process.env.MS_CLIENT_ID;
    if (!clientId) {
      throw new Error('MS_CLIENT_ID env var not set. Run /auth microsoft.');
    }

    const cca = new msal.PublicClientApplication({
      auth: {
        clientId,
        authority: 'https://login.microsoftonline.com/common',
      },
    });

    const tokenRaw = await fs.readFile(MS_TOKEN_PATH, 'utf8').catch(() => null);
    if (tokenRaw) {
      const cached = JSON.parse(tokenRaw);
      if (cached.expiresAt && Date.now() < cached.expiresAt - 60_000) {
        this.accessToken = cached.accessToken;
        this.expiresAt = cached.expiresAt;
        return cached.accessToken;
      }
    }

    // Fall back to device-code flow — interactive, run via /auth microsoft.
    const result = await cca.acquireTokenByDeviceCode({
      scopes: MS_SCOPES,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deviceCodeCallback: (resp: any) => {
        // eslint-disable-next-line no-console
        console.log(resp.message);
      },
    });

    if (!result?.accessToken) {
      throw new Error('Microsoft device-code flow returned no token.');
    }
    this.accessToken = result.accessToken;
    this.expiresAt = result.expiresOn?.getTime() ?? Date.now() + 3600_000;

    await fs.mkdir(path.dirname(MS_TOKEN_PATH), { recursive: true });
    await fs.writeFile(
      MS_TOKEN_PATH,
      JSON.stringify({ accessToken: this.accessToken, expiresAt: this.expiresAt }, null, 2),
    );

    return result.accessToken;
  }
}

const msAuth = new MicrosoftAuthManager();

async function graphGet(pathStr: string): Promise<unknown> {
  const token = await msAuth.ensure();
  const res = await fetch(`${MS_GRAPH}${pathStr}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Graph ${pathStr}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export class OutlookMailIngester implements CloudIngester {
  readonly source = 'outlook-mail';

  async fetch(since: Date): Promise<{ facts: Fact[]; errors: string[] }> {
    const errors: string[] = [];
    const facts: Fact[] = [];
    try {
      const data = (await graphGet(
        `/me/messages?$top=50&$filter=receivedDateTime ge ${since.toISOString()}&$select=subject,from,receivedDateTime,bodyPreview,conversationId,webLink`,
      )) as { value?: Array<Record<string, unknown>> };

      for (const m of data.value ?? []) {
        const fromObj = m.from as { emailAddress?: { name?: string; address?: string } } | undefined;
        const fromText =
          fromObj?.emailAddress?.name ?? fromObj?.emailAddress?.address ?? 'unknown';
        facts.push({
          text: `Outlook email from ${fromText} subject "${m.subject}" on ${m.receivedDateTime}: ${stripHtml(String(m.bodyPreview ?? '')).slice(0, 500)}`,
          source: 'outlook-mail',
          sourceId: String(m.id ?? ''),
          link: m.webLink ? String(m.webLink) : undefined,
          occurredAt: new Date(String(m.receivedDateTime ?? since)),
          meta: { conversationId: String(m.conversationId ?? '') },
        });
      }
    } catch (e) {
      errors.push(`outlook-mail: ${(e as Error).message}`);
    }
    return { facts, errors };
  }
}

export class OutlookCalendarIngester implements CloudIngester {
  readonly source = 'outlook-calendar';

  async fetch(since: Date): Promise<{ facts: Fact[]; errors: string[] }> {
    const errors: string[] = [];
    const facts: Fact[] = [];
    try {
      const end = new Date();
      end.setDate(end.getDate() + 7);
      const data = (await graphGet(
        `/me/calendarView?startDateTime=${since.toISOString()}&endDateTime=${end.toISOString()}&$top=100&$select=subject,start,end,location,attendees,isAllDay,webLink`,
      )) as { value?: Array<Record<string, unknown>> };

      for (const ev of data.value ?? []) {
        const start = (ev.start as { dateTime?: string })?.dateTime ?? '';
        const endIso = (ev.end as { dateTime?: string })?.dateTime ?? '';
        const loc = (ev.location as { displayName?: string })?.displayName ?? '';
        const attendees = ((ev.attendees as Array<Record<string, unknown>>) ?? [])
          .map((a) => {
            const ea = a.emailAddress as { name?: string; address?: string } | undefined;
            return ea?.name ?? ea?.address;
          })
          .filter(Boolean)
          .join(', ');
        facts.push({
          text: `Outlook event "${ev.subject ?? '(no title)'}" ${start}–${endIso}${loc ? ` at ${loc}` : ''}${attendees ? ` with ${attendees}` : ''}`,
          source: 'outlook-calendar',
          sourceId: String(ev.id ?? ''),
          link: ev.webLink ? String(ev.webLink) : undefined,
          occurredAt: start ? new Date(start) : undefined,
        });
      }
    } catch (e) {
      errors.push(`outlook-calendar: ${(e as Error).message}`);
    }
    return { facts, errors };
  }
}

export class OutlookContactsIngester implements CloudIngester {
  readonly source = 'outlook-contacts';

  async fetch(_since: Date): Promise<{ facts: Fact[]; errors: string[] }> {
    const errors: string[] = [];
    const facts: Fact[] = [];
    try {
      const data = (await graphGet(
        `/me/contacts?$top=200&$select=displayName,emailAddresses,businessPhones,mobilePhone,companyName,jobTitle`,
      )) as { value?: Array<Record<string, unknown>> };

      for (const c of data.value ?? []) {
        const name = String(c.displayName ?? '');
        const emails = ((c.emailAddresses as Array<{ address?: string }>) ?? [])
          .map((e) => e.address)
          .filter(Boolean)
          .join(', ');
        const phones = [
          ...((c.businessPhones as string[]) ?? []),
          ...(c.mobilePhone ? [String(c.mobilePhone)] : []),
        ].join(', ');
        const company = c.companyName ? String(c.companyName) : '';
        const title = c.jobTitle ? String(c.jobTitle) : '';

        if (!name && !emails && !phones) continue;

        facts.push({
          text: `Contact ${name}${emails ? ` <${emails}>` : ''}${phones ? `, phone ${phones}` : ''}${title || company ? `, ${title}${company ? ` at ${company}` : ''}` : ''}`,
          source: 'outlook-contacts',
          sourceId: String(c.id ?? ''),
        });
      }
    } catch (e) {
      errors.push(`outlook-contacts: ${(e as Error).message}`);
    }
    return { facts, errors };
  }
}

export const microsoftIngesters: CloudIngester[] = [
  new OutlookMailIngester(),
  new OutlookCalendarIngester(),
  new OutlookContactsIngester(),
];
