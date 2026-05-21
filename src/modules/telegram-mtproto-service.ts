/**
 * PocketClaw — Telegram MTProto sign-in service.
 *
 * Drives the GramJS sign-in state machine. The Telegram bot adapter calls
 * these functions in response to user DMs (`/connect_telegram`, then the
 * SMS code, then the 2FA password if applicable).
 *
 * State persists in memory only — the user has 5 minutes to complete the
 * flow (Telegram code expiry). Restarting the host invalidates any
 * in-progress sign-in.
 *
 * After successful sign-in the session string is written to disk at
 * `${POCKETCLAW_SECRETS_DIR}/telegram_session.txt`. Future host starts
 * pick it up automatically — no re-prompt.
 *
 * Why this exists in the host (not just a CLI script):
 *   - The user can drive sign-in from anywhere they can reach the bot
 *     (their phone, another machine) without opening a terminal
 *   - 2FA + SMS code arrive on the same Telegram account they're already
 *     signed into, so it's a self-contained conversational flow
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { envPath, expandHome } from './paths.js';

export type ConnectStep = 'idle' | 'awaiting_code' | 'awaiting_password' | 'connected' | 'error';

interface PendingSignIn {
  client: TelegramClient;
  resolveCode: ((value: string) => void) | null;
  rejectCode: ((reason: Error) => void) | null;
  resolvePassword: ((value: string) => void) | null;
  rejectPassword: ((reason: Error) => void) | null;
  step: ConnectStep;
  startedAt: number;
  phone: string;
  errorMessage?: string;
  /** Promise that resolves when client.start() finishes (success or error). */
  signInPromise: Promise<void> | null;
}

const SESSION_TTL_MS = 5 * 60 * 1000; // Telegram code expires in 2 min; we give 5 to enter 2FA too
const pending = new Map<string, PendingSignIn>();

function sessionPath(): string {
  if (process.env.TELEGRAM_SESSION_PATH) return expandHome(process.env.TELEGRAM_SESSION_PATH);
  const secretsDir = process.env.POCKETCLAW_SECRETS_DIR
    ? expandHome(process.env.POCKETCLAW_SECRETS_DIR)
    : envPath('POCKETCLAW_SECRETS_DIR', 'secrets');
  return path.join(secretsDir, 'telegram_session.txt');
}

/**
 * Has the user already signed in? Used by the runtime ingester at host
 * startup to decide whether to spin up a session.
 */
export async function hasExistingSession(): Promise<boolean> {
  try {
    const data = await fs.readFile(sessionPath(), 'utf8');
    return data.trim().length > 100; // empty/dummy strings will fail this
  } catch {
    return false;
  }
}

/**
 * Step 1 of /connect_telegram: user just sent the bot the phone number.
 * Telegram texts the code to that phone within seconds.
 */
export async function startConnect(userKey: string, phone: string): Promise<{ step: ConnectStep; message: string }> {
  // Cancel any prior in-progress flow for this user
  cancel(userKey);

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) {
    return {
      step: 'error',
      message: 'TELEGRAM_API_ID / TELEGRAM_API_HASH not set in .env. Get them from https://my.telegram.org/apps and add to .env, then restart the host.',
    };
  }

  const stringSession = new StringSession('');
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 3,
    baseLogger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never,
  });

  const state: PendingSignIn = {
    client,
    resolveCode: null,
    rejectCode: null,
    resolvePassword: null,
    rejectPassword: null,
    step: 'idle',
    startedAt: Date.now(),
    phone,
    signInPromise: null,
  };

  // Kick off the sign-in. Inside callbacks we move state forward.
  state.signInPromise = client
    .start({
      phoneNumber: async () => phone,
      phoneCode: async () =>
        new Promise<string>((resolve, reject) => {
          state.step = 'awaiting_code';
          state.resolveCode = resolve;
          state.rejectCode = reject;
        }),
      password: async () =>
        new Promise<string>((resolve, reject) => {
          state.step = 'awaiting_password';
          state.resolvePassword = resolve;
          state.rejectPassword = reject;
        }),
      onError: (err: Error) => {
        state.step = 'error';
        state.errorMessage = err.message;
      },
    })
    .then(async () => {
      // Sign-in succeeded — write session + transition to connected
      const session = client.session.save() as unknown as string;
      const target = sessionPath();
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, session, { mode: 0o600 });
      state.step = 'connected';
    })
    .catch((err: Error) => {
      state.step = 'error';
      state.errorMessage = err.message;
    })
    .finally(() => {
      // Disconnect after success or terminal error to free the socket
      try {
        client.disconnect().catch(() => {});
      } catch {
        // ignore
      }
    });

  pending.set(userKey, state);

  // Wait briefly for state machine to enter awaiting_code or error
  for (let i = 0; i < 60; i++) {
    if (state.step === 'awaiting_code' || state.step === 'error') break;
    await new Promise((r) => setTimeout(r, 250));
  }

  if (state.step === 'awaiting_code') {
    return {
      step: 'awaiting_code',
      message: `Telegram should have texted a 5-digit code to ${phone}. Reply with that code (just digits, no spaces).`,
    };
  }
  if (state.step === 'error') {
    pending.delete(userKey);
    return { step: 'error', message: `Sign-in failed: ${state.errorMessage ?? 'unknown error'}` };
  }
  return {
    step: state.step,
    message: 'Telegram is taking longer than usual to send the code. Try again in a moment.',
  };
}

/** Step 2: user replied with the SMS code. */
export async function submitCode(userKey: string, code: string): Promise<{ step: ConnectStep; message: string }> {
  const state = pending.get(userKey);
  if (!state) {
    return { step: 'error', message: 'No sign-in in progress. Send `/connect_telegram` to start.' };
  }
  if (Date.now() - state.startedAt > SESSION_TTL_MS) {
    cancel(userKey);
    return { step: 'error', message: 'Sign-in expired (>5 min). Send `/connect_telegram` to start over.' };
  }
  if (state.step !== 'awaiting_code' || !state.resolveCode) {
    return { step: state.step, message: `Wrong step: currently ${state.step}` };
  }

  const cleaned = code.replace(/\D/g, '');
  if (!cleaned) return { step: state.step, message: 'That doesn\'t look like a code. Send just the digits Telegram sent you.' };
  state.resolveCode(cleaned);
  state.resolveCode = null;

  // Wait for state to advance to awaiting_password or connected or error
  for (let i = 0; i < 60; i++) {
    const step = state.step as ConnectStep;
    if (step === 'awaiting_password' || step === 'connected' || step === 'error') break;
    await new Promise((r) => setTimeout(r, 250));
  }

  if ((state.step as ConnectStep) === 'awaiting_password') {
    return {
      step: 'awaiting_password',
      message: 'Two-factor auth is enabled on your account. Reply with your 2FA password (will not be echoed).',
    };
  }
  if ((state.step as ConnectStep) === 'connected') {
    pending.delete(userKey);
    return {
      step: 'connected',
      message: '✅ Connected. Telegram MTProto session saved. Restart the host (or wait for next session) to start ingesting your chats.',
    };
  }
  if ((state.step as ConnectStep) === 'error') {
    const msg = state.errorMessage ?? 'unknown error';
    pending.delete(userKey);
    return { step: 'error', message: `Code rejected or sign-in failed: ${msg}. Send /connect_telegram to retry.` };
  }
  return { step: state.step, message: 'Still working...' };
}

/** Step 3 (only if 2FA is on): user replied with the 2FA password. */
export async function submitPassword(userKey: string, password: string): Promise<{ step: ConnectStep; message: string }> {
  const state = pending.get(userKey);
  if (!state) {
    return { step: 'error', message: 'No sign-in in progress.' };
  }
  if (state.step !== 'awaiting_password' || !state.resolvePassword) {
    return { step: state.step, message: `Wrong step: currently ${state.step}` };
  }
  state.resolvePassword(password);
  state.resolvePassword = null;

  for (let i = 0; i < 60; i++) {
    const step = state.step as ConnectStep;
    if (step === 'connected' || step === 'error') break;
    await new Promise((r) => setTimeout(r, 250));
  }

  if ((state.step as ConnectStep) === 'connected') {
    pending.delete(userKey);
    return {
      step: 'connected',
      message: '✅ Connected. Telegram MTProto session saved. Restart the host with `nssm restart pocketclaw` to start ingesting.',
    };
  }
  const msg = state.errorMessage ?? 'unknown';
  pending.delete(userKey);
  return { step: 'error', message: `2FA failed: ${msg}. Send /connect_telegram to retry.` };
}

/** Cancel any in-progress flow for a user. Idempotent. */
export function cancel(userKey: string): void {
  const state = pending.get(userKey);
  if (!state) return;
  try {
    state.client.disconnect().catch(() => {});
  } catch {
    // ignore
  }
  if (state.rejectCode) state.rejectCode(new Error('cancelled'));
  if (state.rejectPassword) state.rejectPassword(new Error('cancelled'));
  pending.delete(userKey);
}

/**
 * In-process state inspection for debugging via /status or logs.
 */
export function inspectPending(): Array<{ userKey: string; step: ConnectStep; phone: string; ageSec: number }> {
  return Array.from(pending.entries()).map(([userKey, s]) => ({
    userKey,
    step: s.step,
    phone: s.phone.replace(/\d{4}$/, '****'),
    ageSec: Math.round((Date.now() - s.startedAt) / 1000),
  }));
}
