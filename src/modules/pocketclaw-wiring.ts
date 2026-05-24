/**
 * PocketClaw — host-side wiring for the wiki + digest cron handlers.
 *
 * Imported for side effects from `src/modules/index.ts`. Does two things:
 *
 *   1. Provides a Bedrock-backed `callClaude(prompt) -> text` callback to the
 *      wiki cron via setWikiProvider(). Shells out to `aws bedrock-runtime
 *      invoke-model`, which inherits AWS_PROFILE / AWS_REGION from the host
 *      env (set in scripts/service/run-host-task.cmd to use `hermes` SSO).
 *      No new SDK dep required, no static creds — auth flows through the
 *      already-verified SSO chain.
 *
 *   2. Provides a digest delivery handler to the morning-digest cron via
 *      setDigestHandler(). Pulls the most recent + most relevant insights
 *      from mnemon, asks Claude for a short conversational digest, and
 *      delivers it through the running ChannelDeliveryAdapter to the
 *      OWNER's Telegram DM (resolved via user_roles + user_dms — no
 *      hard-coded chat id).
 *
 * If anything is missing (no SSO, no mnemon, no delivery adapter, no DM
 * resolved yet), the handlers fail soft and audit-log the reason — they
 * never crash the host process.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { setWikiProvider, setDigestHandler } from './pocketclaw.js';
import { onDeliveryAdapterReady, getDeliveryAdapter } from '../delivery.js';
import { getDb } from '../db/connection.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { envPath} from './paths.js';
import { runMnemon } from './mnemon-runner.js';
import { log } from '../log.js';

const LOG_PATH = envPath('LOG_PATH', 'logs');
const AUDIT_LOG = path.join(LOG_PATH, 'audit.log');

const BEDROCK_MODEL_ID =
  process.env.ANTHROPIC_MODEL ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const BEDROCK_REGION = process.env.AWS_REGION ?? 'us-east-1';
const BEDROCK_MAX_TOKENS = 4096;

async function audit(line: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(AUDIT_LOG), { recursive: true });
    await fs.appendFile(AUDIT_LOG, `${new Date().toISOString()} | ${line}\n`, 'utf8');
  } catch {
    // best-effort; never fail caller
  }
}

/**
 * Invoke Claude on Bedrock via the AWS CLI.
 *
 * We could use @aws-sdk/client-bedrock-runtime, but adding a multi-MB SDK
 * just for the cron path is overkill. The aws CLI is already on PATH
 * (verified during AWS SSO setup), already configured with the `hermes`
 * profile, and shells out cleanly with file-based body I/O.
 */
export async function callBedrockClaude(prompt: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-bedrock-'));
  const bodyPath = path.join(tmpDir, 'body.json');
  const outPath = path.join(tmpDir, 'out.json');

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: BEDROCK_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  };
  await fs.writeFile(bodyPath, JSON.stringify(body), 'utf8');

  try {
    const args = [
      'bedrock-runtime',
      'invoke-model',
      '--model-id',
      BEDROCK_MODEL_ID,
      '--body',
      'fileb://' + bodyPath,
      '--cli-binary-format',
      'raw-in-base64-out',
      '--region',
      BEDROCK_REGION,
      outPath,
    ];

    const exitCode: number = await new Promise((resolve, reject) => {
      const proc = spawn('aws', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      let stderr = '';
      proc.stderr.on('data', (b) => (stderr += b.toString()));
      proc.on('error', (err) => reject(err));
      proc.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`aws bedrock-runtime exited ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        resolve(code);
      });
    });

    if (exitCode !== 0) throw new Error(`aws bedrock-runtime exit ${exitCode}`);
    const raw = await fs.readFile(outPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (parsed.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error('Bedrock returned empty content');
    return text;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run `mnemon recall <query>` and return a compact context string suitable
 * for stuffing into a Claude prompt. Returns empty string if mnemon errors.
 */
async function mnemonRecallText(query: string, limit = 30): Promise<string> {
  // Errors → empty string (digest path is best-effort).
  const r = await runMnemon(['recall', query, '--limit', String(limit)]).catch(
    () => ({ code: -1, stdout: '', stderr: '', retried: false, attempts: 0 }),
  );
  if (r.code !== 0) return '';
  try {
    const j = JSON.parse(r.stdout) as {
      results?: Array<{ insight?: { content?: string } }>;
    };
    return (j.results ?? [])
      .map((row) => row.insight?.content?.trim())
      .filter((s): s is string => !!s)
      .slice(0, limit)
      .join('\n- ');
  } catch {
    return '';
  }
}

/** Find the owner's DM messaging-group on a given channel. */
function getOwnerDmMessagingGroupId(channelType: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT ud.messaging_group_id AS mg
         FROM user_roles ur
         JOIN user_dms ud
           ON ud.user_id = ur.user_id
          AND ud.channel_type = ?
        WHERE ur.role = 'owner'
        ORDER BY ur.granted_at ASC
        LIMIT 1`,
    )
    .get(channelType) as { mg: string } | undefined;
  return row?.mg ?? null;
}

/**
 * Compose + deliver the morning digest. Falls through silently when
 * preconditions aren't met so the cron never explodes the host.
 */
export async function runDigest(): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    await audit('CRON | morning-digest SKIP | no-delivery-adapter');
    return;
  }

  // Resolve owner's Telegram DM. Telegram is the primary morning-digest
  // channel per PRD §7.4. Fall back to whatsapp if telegram DM not wired.
  let mgId = getOwnerDmMessagingGroupId('telegram');
  let channelType = 'telegram';
  if (!mgId) {
    mgId = getOwnerDmMessagingGroupId('whatsapp');
    channelType = 'whatsapp';
  }
  if (!mgId) {
    await audit('CRON | morning-digest SKIP | no-owner-dm');
    return;
  }
  const mg = getMessagingGroup(mgId);
  if (!mg) {
    await audit(`CRON | morning-digest SKIP | mg-not-found ${mgId}`);
    return;
  }

  // Pull recent context from mnemon. We use both temporal ('today') and
  // a few standing topics so the digest has something to say even on
  // quiet days.
  const today = await mnemonRecallText('today', 20);
  const week = await mnemonRecallText('this week', 20);
  const context = [today, week].filter(Boolean).join('\n- ');

  if (!context) {
    await audit('CRON | morning-digest SKIP | mnemon-empty');
    return;
  }

  const date = new Date();
  const human = date.toLocaleString('en-SG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const prompt = `You are PocketClaw, a personal AI assistant. Compose a short, friendly morning digest for the user.

Today is ${human}.

Recent memory context (most recent insights from mnemon):
- ${context}

Write a digest that:
- Opens with a one-line greeting referencing today's date.
- Surfaces 3-5 useful nuggets from the context (anniversaries, follow-ups, contacts to remember, scheduled events). Use bullets.
- Is concise (under 200 words total). Plain text. No markdown headers.
- Mentions tomorrow / the week ahead only if context supports it.

Output the digest text only — no preamble.`;

  let digestText: string;
  try {
    digestText = await callBedrockClaude(prompt);
  } catch (err) {
    await audit(`CRON | morning-digest FAIL | bedrock ${(err as Error).message}`);
    return;
  }

  // Deliver. ChannelDeliveryAdapter.deliver(channelType, platformId,
  // threadId, kind, content) — kind='chat' for a normal user-facing
  // message, content is the JSON-encoded chat payload.
  try {
    const content = JSON.stringify({ text: digestText });
    await adapter.deliver(channelType, mg.platform_id, null, 'chat', content);
    await audit(
      `CRON | morning-digest DELIVERED | channel=${channelType} mg=${mgId} chars=${digestText.length}`,
    );
  } catch (err) {
    await audit(`CRON | morning-digest FAIL | deliver ${(err as Error).message}`);
  }
}

// Wire the wiki provider immediately. setWikiProvider just stashes the
// callback; the cron loop will pick it up on the next 03:00 fire.
try {
  setWikiProvider(callBedrockClaude);
  log.info('PocketClaw wiring: wiki provider attached (Bedrock CLI)');
} catch (err) {
  log.error('PocketClaw wiring: setWikiProvider failed', { err });
}

// Wire the digest handler. runDigest checks getDeliveryAdapter() at call
// time, so we don't need to wait for the adapter to be ready here. We
// audit-log when the adapter arrives so operators see the boot chain
// complete.
try {
  setDigestHandler(runDigest);
  log.info('PocketClaw wiring: digest handler attached');
} catch (err) {
  log.error('PocketClaw wiring: setDigestHandler failed', { err });
}

onDeliveryAdapterReady(() => {
  void audit('POCKETCLAW_WIRING | delivery adapter ready, digest handler armed');
});
