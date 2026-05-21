/**
 * PocketClaw — Telegram MTProto sign-in (one-shot, interactive)
 *
 * Run ONCE while the user is awake to capture an MTProto session string.
 * The session string is written to `~/.pocketclaw/secrets/telegram_session.txt`
 * (path overridable via TELEGRAM_SESSION_PATH). Subsequent service restarts
 * pick it up automatically — no SMS code, no prompts.
 *
 * Why MTProto and not the Bot API: bots can ONLY see messages addressed to
 * them. To read your own DMs, group history, and everything else you can
 * see in the Telegram app, we have to sign in AS YOU via MTProto.
 *
 * Security:
 *   - The session string is the equivalent of a logged-in Telegram client.
 *     Anyone with this file can read all your Telegram messages.
 *   - Stored in `secrets/`, gitignored.
 *   - Revocable from Telegram → Settings → Devices → Active sessions.
 *
 * Usage:
 *   pnpm tg:login
 *   # → texts you a 5-digit code
 *   # → asks for it interactively
 *   # → if 2FA is on, asks for password
 *   # → writes session and exits
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import { envPath } from '../src/modules/paths.js';

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const phone = process.env.TELEGRAM_PHONE;

if (!apiId || !apiHash || !phone) {
  console.error('Missing TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_PHONE in .env.');
  console.error('Get them from https://my.telegram.org/apps and set in .env, then re-run.');
  process.exit(1);
}

const secretsDir = process.env.POCKETCLAW_SECRETS_DIR
  ? process.env.POCKETCLAW_SECRETS_DIR.replace(/^~/, process.env.USERPROFILE ?? process.env.HOME ?? '~')
  : envPath('POCKETCLAW_SECRETS_DIR', 'secrets');
const sessionPath = process.env.TELEGRAM_SESSION_PATH ?? path.join(secretsDir, 'telegram_session.txt');

// If a session already exists, load and verify it instead of re-prompting.
let existingSession = '';
try {
  existingSession = await fs.readFile(sessionPath, 'utf8');
  console.log(`Found existing session at ${sessionPath} (${existingSession.length} chars). Verifying...`);
} catch {
  // first run — fine
}

const stringSession = new StringSession(existingSession.trim());
const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
  baseLogger: { warn: () => {}, info: () => {}, error: console.error, debug: () => {} } as never,
});

await client.start({
  phoneNumber: async () => phone,
  password: async () => {
    return await input.text('Telegram 2FA password (leave blank if none, then press Enter): ');
  },
  phoneCode: async () => {
    return await input.text('Enter the SMS code Telegram just sent you: ');
  },
  onError: (err) => {
    console.error('Sign-in error:', err.message);
  },
});

await fs.mkdir(path.dirname(sessionPath), { recursive: true });
const session = client.session.save() as unknown as string;
await fs.writeFile(sessionPath, session, { mode: 0o600 });

const me = await client.getMe();
const meAny = me as { firstName?: string; username?: string; id?: { toString(): string } };
console.log('');
console.log('✅ Signed in as:', meAny.firstName ?? '(no name)', meAny.username ? `@${meAny.username}` : '');
console.log(`   user-id:  ${meAny.id?.toString() ?? 'unknown'}`);
console.log(`   session:  ${sessionPath} (${session.length} chars)`);
console.log('');
console.log('You can now restart the host (`nssm restart pocketclaw`) and');
console.log('Telegram MTProto ingestion will start running.');

await client.disconnect();
process.exit(0);
