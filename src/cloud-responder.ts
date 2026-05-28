/**
 * Cloud-mode WhatsApp responder.
 *
 * Direct-path responder used until the sub-agent ECS service is live.
 * Loads persona from `container/sub-agent/src/persona/system_prompt_template.json`
 * (mounted into the orchestrator image at `/app/persona/system_prompt_template.json`).
 *
 * Sliding-window in-memory history per chat (last 20 turns), persisted to
 * DynamoDB `nanoclaw-chat-messages`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import type { ChannelAdapter, InboundMessage } from './channels/adapter.js';
import { log as baseLog } from './log.js';

const log = baseLog;

const REGION = process.env.AWS_REGION ?? 'ap-southeast-1';
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';
const MESSAGES_TABLE = process.env.MESSAGES_TABLE ?? 'nanoclaw-chat-messages';
const HISTORY_LIMIT = 20;
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Clawd';

const bedrock = new BedrockRuntimeClient({ region: REGION });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}
const histories = new Map<string, Turn[]>();

// ──────────────────────────────────────────────────────────────────────
// Persona loading
// ──────────────────────────────────────────────────────────────────────

interface PersonaJson {
  version: string;
  sections: Record<string, string | unknown[]>;
}

const PERSONA_CANDIDATES = [
  process.env.PERSONA_PATH,
  '/app/persona/system_prompt_template.json',
  path.resolve(process.cwd(), 'persona/system_prompt_template.json'),
  path.resolve(process.cwd(), 'container/sub-agent/src/persona/system_prompt_template.json'),
].filter((p): p is string => typeof p === 'string' && p.length > 0);

function loadPersona(): PersonaJson | null {
  for (const candidate of PERSONA_CANDIDATES) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as PersonaJson;
      log.info(`Persona loaded from ${candidate} version=${parsed.version}`);
      return parsed;
    } catch (err) {
      log.warn(`Persona load failed at ${candidate}: ${(err as Error).message}`);
    }
  }
  return null;
}

function buildSystemPrompt(): string {
  const persona = loadPersona();
  if (!persona) {
    log.warn('No persona JSON found — falling back to hardcoded minimal prompt');
    return [
      `You are ${ASSISTANT_NAME}, a friendly personal AI assistant on WhatsApp.`,
      `Be warm, concise, conversational. Use *bold* and _italic_ only (never ** or __).`,
      `Short replies. No filler. Match the user's energy.`,
      `Your name is ${ASSISTANT_NAME}. Never adopt another name.`,
    ].join('\n');
  }

  const order = [
    'identity',
    'voice',
    'formatting',
    'memory',
    'capabilities',
    'knowledgeBase',
    'photos',
    'guardrails',
    'confidence',
    'interactionStyle',
    'namingDiscipline',
  ];

  const parts: string[] = [];
  for (const key of order) {
    const v = persona.sections[key];
    if (typeof v === 'string' && v.trim()) {
      const heading = key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
      parts.push(`## ${heading}\n${v.trim()}`);
    }
  }

  // Append few-shot examples if present
  const examples = persona.sections['examples'];
  if (Array.isArray(examples) && examples.length > 0) {
    const lines: string[] = ['## Few-shot Examples'];
    for (const ex of examples) {
      if (ex && typeof ex === 'object') {
        const e = ex as { input?: string; good?: string; bad?: string };
        if (e.input && e.good) {
          lines.push(`User: ${e.input}\nGood: ${e.good}` + (e.bad ? `\nBad (avoid): ${e.bad}` : ''));
        }
      }
    }
    if (lines.length > 1) parts.push(lines.join('\n\n'));
  }

  return parts.join('\n\n');
}

const SYSTEM_PROMPT = buildSystemPrompt();

// ──────────────────────────────────────────────────────────────────────
// Persistence
// ──────────────────────────────────────────────────────────────────────

async function persistMessage(userId: string, role: 'user' | 'assistant', text: string): Promise<void> {
  try {
    const ts = new Date().toISOString();
    const ttlSeconds = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60; // 90d
    await dynamo.send(new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: {
        userId,
        timestamp: ts,
        role,
        text,
        ttl: ttlSeconds,
      },
    }));
  } catch (err) {
    log.warn(`Failed to persist message: ${(err as Error).message}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Bedrock call
// ──────────────────────────────────────────────────────────────────────

async function callBedrock(history: Turn[]): Promise<{ text: string; ms: number; inputTokens: number; outputTokens: number }> {
  const t0 = Date.now();

  const messages = history.map(t => ({
    role: t.role,
    content: [{ type: 'text', text: t.content }],
  }));

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1024,
    temperature: 0.7,
    system: SYSTEM_PROMPT,
    messages,
  };

  const cmd = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body),
  });

  const resp = await bedrock.send(cmd);
  const decoded = JSON.parse(new TextDecoder().decode(resp.body)) as {
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };

  const text = decoded.content
    .filter(c => c.type === 'text' && c.text)
    .map(c => c.text!)
    .join('\n')
    .trim();

  return {
    text,
    ms: Date.now() - t0,
    inputTokens: decoded.usage?.input_tokens ?? 0,
    outputTokens: decoded.usage?.output_tokens ?? 0,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Public entry point — registered as channelRequestGate in cloud mode.
// ──────────────────────────────────────────────────────────────────────

export async function respondToDM(
  adapter: ChannelAdapter,
  platformId: string,
  message: InboundMessage,
): Promise<void> {
  const content = (message.content as Record<string, unknown> | undefined) ?? {};
  const userText = (
    (typeof content.text === 'string' && content.text) ||
    (typeof content.caption === 'string' && content.caption) ||
    ''
  ).trim();
  if (!userText) return;

  const userId = (typeof content.sender === 'string' && content.sender) || platformId;

  // append user turn
  const history = histories.get(platformId) ?? [];
  history.push({ role: 'user', content: userText });
  if (history.length > HISTORY_LIMIT * 2) history.splice(0, history.length - HISTORY_LIMIT * 2);
  histories.set(platformId, history);

  // persist user message in parallel (non-blocking)
  persistMessage(userId, 'user', userText).catch(() => {});

  try {
    const { text, ms, inputTokens, outputTokens } = await callBedrock(history);
    log.info(`Bedrock reply platformId=${platformId} ms=${ms} inputTokens=${inputTokens} outputTokens=${outputTokens} replyLen=${text.length}`);

    // append assistant turn
    history.push({ role: 'assistant', content: text });
    histories.set(platformId, history);

    // persist + send in parallel
    persistMessage(userId, 'assistant', text).catch(() => {});

    await adapter.deliver(platformId, null, {
      kind: 'chat',
      content: { text, markdown: text },
    });
  } catch (err) {
    log.error(`Cloud responder failed for ${platformId}: ${(err as Error).message}`);
    try {
      await adapter.deliver(platformId, null, {
        kind: 'chat',
        content: {
          text: "Hit a snag on my end. Try again in a sec.",
          markdown: "Hit a snag on my end. Try again in a sec.",
        },
      });
    } catch {
      /* swallow */
    }
  }
}
