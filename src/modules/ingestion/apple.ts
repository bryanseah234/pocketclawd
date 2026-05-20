/**
 * PocketClaw — Apple iCloud ingestion (IMAP / CalDAV / CardDAV) — PRD §7.9.3
 *
 * Auth: APPLE_ID_EMAIL + APPLE_APP_PASSWORD (app-specific password from
 * https://appleid.apple.com → Security → App-Specific Passwords).
 *
 * Note on Apple Principal ID (PRD §16): CalDAV/CardDAV URLs require the
 * principal ID, which Apple gates per-account. Discover it by issuing a
 * PROPFIND against `https://contacts.icloud.com/.well-known/carddav` with
 * the user's credentials — Apple returns a redirect to
 * `https://p<NN>-contacts.icloud.com/<principal>/carddavhome/`. The
 * `<principal>` segment is the principal ID. The `tsdav` library handles
 * this automatically when given just the email + app password.
 */

import type { CloudIngester, Fact } from './types.js';
import { stripHtml } from './types.js';

const APPLE_EMAIL = process.env.APPLE_ID_EMAIL ?? '';
const APPLE_PASS = process.env.APPLE_APP_PASSWORD ?? '';

const IMAP_HOST = 'imap.mail.me.com';
const IMAP_PORT = 993;
const CALDAV_BASE = 'https://caldav.icloud.com';
const CARDDAV_BASE = 'https://contacts.icloud.com';

function ensureCreds(): void {
  if (!APPLE_EMAIL || !APPLE_PASS) {
    throw new Error(
      'Apple iCloud creds missing. Set APPLE_ID_EMAIL and APPLE_APP_PASSWORD env vars.',
    );
  }
}

export class AppleMailIngester implements CloudIngester {
  readonly source = 'icloud-mail';

  async fetch(since: Date): Promise<{ facts: Fact[]; errors: string[] }> {
    const errors: string[] = [];
    const facts: Fact[] = [];

    try {
      ensureCreds();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let ImapFlow: any;
      try {
        // @ts-expect-error optional dep
        ({ ImapFlow } = await import('imapflow'));
      } catch {
        throw new Error('imapflow not installed. Run `pnpm install imapflow`.');
      }

      const client = new ImapFlow({
        host: IMAP_HOST,
        port: IMAP_PORT,
        secure: true,
        auth: { user: APPLE_EMAIL, pass: APPLE_PASS },
        logger: false,
      });

      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const since_ = since;
        for await (const msg of client.fetch(
          { since: since_ },
          { envelope: true, source: true, bodyParts: ['text'] },
        )) {
          try {
            const env = msg.envelope;
            const fromAddr = env?.from?.[0];
            const fromText = fromAddr?.name ?? fromAddr?.address ?? 'unknown';
            const subject = env?.subject ?? '';
            const date = env?.date ?? since;
            const body = msg.source ? stripHtml(msg.source.toString('utf8')) : '';

            facts.push({
              text: `iCloud email from ${fromText} subject "${subject}" on ${new Date(date).toISOString()}: ${body.slice(0, 500)}`,
              source: 'icloud-mail',
              sourceId: String(msg.uid),
              occurredAt: new Date(date),
            });
          } catch (e) {
            errors.push(`icloud-mail msg ${msg.uid}: ${(e as Error).message}`);
          }
        }
      } finally {
        lock.release();
        await client.logout();
      }
    } catch (e) {
      errors.push(`icloud-mail: ${(e as Error).message}`);
    }

    return { facts, errors };
  }
}

export class AppleCalendarIngester implements CloudIngester {
  readonly source = 'icloud-calendar';

  async fetch(since: Date): Promise<{ facts: Fact[]; errors: string[] }> {
    const errors: string[] = [];
    const facts: Fact[] = [];

    try {
      ensureCreds();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let tsdav: any;
      try {
        // @ts-expect-error optional dep
        tsdav = await import('tsdav');
      } catch {
        throw new Error('tsdav not installed. Run `pnpm install tsdav`.');
      }

      const client = new tsdav.DAVClient({
        serverUrl: CALDAV_BASE,
        credentials: { username: APPLE_EMAIL, password: APPLE_PASS },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      });
      await client.login();
      const calendars = await client.fetchCalendars();
      const end = new Date();
      end.setDate(end.getDate() + 7);

      for (const cal of calendars) {
        try {
          const events = await client.fetchCalendarObjects({
            calendar: cal,
            timeRange: { start: since.toISOString(), end: end.toISOString() },
          });
          for (const ev of events) {
            const ics = String(ev.data ?? '');
            const summary = matchIcsField(ics, 'SUMMARY') ?? '(no title)';
            const dtstart = matchIcsField(ics, 'DTSTART') ?? '';
            const dtend = matchIcsField(ics, 'DTEND') ?? '';
            const location = matchIcsField(ics, 'LOCATION') ?? '';
            facts.push({
              text: `iCloud event "${summary}" ${dtstart}–${dtend}${location ? ` at ${location}` : ''}`,
              source: 'icloud-calendar',
              sourceId: String(ev.url ?? ''),
              occurredAt: dtstart ? parseIcsDate(dtstart) : undefined,
            });
          }
        } catch (e) {
          errors.push(`icloud-calendar ${cal.displayName}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      errors.push(`icloud-calendar: ${(e as Error).message}`);
    }

    return { facts, errors };
  }
}

export class AppleContactsIngester implements CloudIngester {
  readonly source = 'icloud-contacts';

  async fetch(_since: Date): Promise<{ facts: Fact[]; errors: string[] }> {
    const errors: string[] = [];
    const facts: Fact[] = [];

    try {
      ensureCreds();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let tsdav: any;
      try {
        // @ts-expect-error optional dep
        tsdav = await import('tsdav');
      } catch {
        throw new Error('tsdav not installed. Run `pnpm install tsdav`.');
      }

      const client = new tsdav.DAVClient({
        serverUrl: CARDDAV_BASE,
        credentials: { username: APPLE_EMAIL, password: APPLE_PASS },
        authMethod: 'Basic',
        defaultAccountType: 'carddav',
      });
      await client.login();
      const books = await client.fetchAddressBooks();
      for (const ab of books) {
        try {
          const cards = await client.fetchVCards({ addressBook: ab });
          for (const card of cards) {
            const vcard = String(card.data ?? '');
            const fn = matchVcardField(vcard, 'FN') ?? '';
            const emails = matchAllVcardFields(vcard, 'EMAIL').join(', ');
            const tels = matchAllVcardFields(vcard, 'TEL').join(', ');
            const org = matchVcardField(vcard, 'ORG') ?? '';
            if (!fn && !emails && !tels) continue;
            facts.push({
              text: `iCloud contact ${fn}${emails ? ` <${emails}>` : ''}${tels ? `, phone ${tels}` : ''}${org ? `, ${org}` : ''}`,
              source: 'icloud-contacts',
              sourceId: String(card.url ?? ''),
            });
          }
        } catch (e) {
          errors.push(`icloud-contacts ${ab.displayName}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      errors.push(`icloud-contacts: ${(e as Error).message}`);
    }

    return { facts, errors };
  }
}

function matchIcsField(ics: string, field: string): string | undefined {
  const re = new RegExp(`^${field}(?:;[^:]*)?:(.+)$`, 'mi');
  return ics.match(re)?.[1]?.trim();
}

function parseIcsDate(s: string): Date | undefined {
  // Handles `YYYYMMDDTHHmmssZ` and ISO formats
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (compact) {
    return new Date(
      Date.UTC(
        Number(compact[1]),
        Number(compact[2]) - 1,
        Number(compact[3]),
        Number(compact[4]),
        Number(compact[5]),
        Number(compact[6]),
      ),
    );
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

function matchVcardField(vcard: string, field: string): string | undefined {
  const re = new RegExp(`^${field}(?:;[^:]*)?:(.+)$`, 'mi');
  return vcard.match(re)?.[1]?.trim();
}

function matchAllVcardFields(vcard: string, field: string): string[] {
  const re = new RegExp(`^${field}(?:;[^:]*)?:(.+)$`, 'gmi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(vcard))) {
    if (m[1]) out.push(m[1].trim());
  }
  return out;
}

export const appleIngesters: CloudIngester[] = [
  new AppleMailIngester(),
  new AppleCalendarIngester(),
  new AppleContactsIngester(),
];
