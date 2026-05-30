/**
 * Clawd — host-side wiring for the morning-digest cron handler.
 *
 * Imported for side effects from `src/modules/index.ts`.
 *
 *   - F2 morning digest (07:00): wired via `setDigestHandler`. Iterates the
 *     consenting users in DynamoDB, asks Bedrock (Sonnet 4.5) for a 3-bullet
 *     digest of their last 24h of chat history, and pushes the result to the
 *     WhatsApp channel through the delivery adapter. Best-effort per user.
 *
 * Gated on env: set CLAWD_CRON_DIGEST=true to enable it in the running
 * orchestrator. Default is FALSE so deployments stay quiet until opted in.
 *
 * (The former F3 wiki-regen path was removed with local mode — it depended on
 * the deleted local pgvector WikiGenerator.)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { onDeliveryAdapterReady, getDeliveryAdapter } from '../delivery.js';
import { envPath } from './paths.js';
import { setDigestHandler } from './clawd.js';

const LOG_PATH = envPath('LOG_PATH', 'logs');
const AUDIT_LOG = path.join(LOG_PATH, 'audit.log');

async function audit(line: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(AUDIT_LOG), { recursive: true });
    await fs.appendFile(AUDIT_LOG, `${new Date().toISOString()} | ${line}\n`, 'utf8');
  } catch {
    // best-effort; never fail caller
  }
}

// ── Bedrock chat (Sonnet 4.5) used by the digest ──
async function bedrockChat(prompt: string): Promise<string> {
  const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const region = process.env.AWS_REGION || 'ap-southeast-1';
  const modelId = process.env.CLAWD_DIGEST_MODEL_ID || 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';
  const client = new BedrockRuntimeClient({ region });
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
  const cmd = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: Buffer.from(JSON.stringify(body), 'utf-8'),
  });
  const resp = await client.send(cmd);
  const payload = JSON.parse(Buffer.from(resp.body as Uint8Array).toString('utf-8')) as {
    content?: Array<{ type: string; text?: string }>;
  };
  return (payload.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim();
}

// ── F2: morning digest handler ──
async function buildAndDeliverDigest(): Promise<void> {
  if (process.env.CLAWD_CRON_DIGEST !== 'true') {
    await audit('CRON | morning-digest SKIP | CLAWD_CRON_DIGEST!=true');
    return;
  }
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    await audit('CRON | morning-digest SKIP | no delivery adapter');
    return;
  }

  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand, QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const region = process.env.AWS_REGION || 'ap-southeast-1';
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const prefsTable = process.env.USER_PREFERENCES_TABLE || 'nanoclaw-user-preferences';
  const chatTable = process.env.CHAT_MESSAGES_TABLE || 'nanoclaw-chat-messages';

  // Scan consenting users
  let consenting: string[] = [];
  try {
    const scan = await ddb.send(new ScanCommand({
      TableName: prefsTable,
      ProjectionExpression: 'userId, consentGiven, dailyDigestEnabled',
      FilterExpression: 'consentGiven = :t AND dailyDigestEnabled = :t',
      ExpressionAttributeValues: { ':t': true },
      Limit: 200,
    }));
    consenting = (scan.Items ?? []).map(it => String(it.userId ?? '')).filter(Boolean);
  } catch (e) {
    await audit(`CRON | morning-digest FAIL | scan: ${(e as Error).message}`);
    return;
  }

  await audit(`CRON | morning-digest | users=${consenting.length}`);
  const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();

  let delivered = 0;
  for (const userId of consenting) {
    try {
      // Get last-24h messages
      const q = await ddb.send(new QueryCommand({
        TableName: chatTable,
        KeyConditionExpression: 'userId = :u AND #ts > :since',
        ExpressionAttributeNames: { '#ts': 'timestamp' },
        ExpressionAttributeValues: { ':u': userId, ':since': yesterday },
        Limit: 50,
      }));
      const items = q.Items ?? [];
      if (items.length === 0) continue;

      const history = items.map(it => `[${it.role}] ${it.content}`.slice(0, 600)).join('\n');
      const prompt = `You are Clawd writing a 3-bullet morning briefing for one of your users. Read the last 24h of conversation below and produce 3 short bullets (• each) covering: 1) what they were working on, 2) anything you noted to follow up on, 3) one helpful nudge for today. Keep it under 80 words total. Do not greet, do not sign off.\n\nCONVERSATION:\n${history}`;
      const text = await bedrockChat(prompt);
      if (!text) continue;

      await adapter.deliver(
        'whatsapp',
        userId,
        userId,
        'text',
        JSON.stringify({ text: `*Morning briefing*\n${text}` }),
      );
      delivered += 1;
    } catch (e) {
      await audit(`CRON | morning-digest user-fail | user=${userId} ${(e as Error).message}`);
    }
  }
  await audit(`CRON | morning-digest END | delivered=${delivered}`);
}

// Register the digest handler under an env gate so deployments stay quiet
// until opted in.
if (process.env.CLAWD_CRON_DIGEST === 'true') {
  setDigestHandler(buildAndDeliverDigest);
}

onDeliveryAdapterReady(() => {
  const digestOn = process.env.CLAWD_CRON_DIGEST === 'true';
  void audit(`CLAWD_WIRING | delivery ready | digest=${digestOn ? 'wired' : 'off'}`);
});
