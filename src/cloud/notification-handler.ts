/**
 * Daily briefing notification handler.
 * Scans all users from DynamoDB, generates a personalised morning briefing
 * via a Bedrock invoker callback, and pushes it to each user's Redis queue.
 *
 * Triggered from index.ts at 07:00 daily.
 */
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { Redis } from 'ioredis';
import { randomUUID } from 'crypto';

export interface NotificationConfig {
  dynamoClient: DynamoDBClient;
  /**
   * Calls the LLM with a prompt and returns the response text.
   * Kept as a callback so notification-handler has no direct Bedrock dep.
   */
  invokeModel: (prompt: string) => Promise<string>;
  redisClient: Redis;
  userPreferencesTable: string;
}

export interface BriefingResult {
  userId: string;
  status: 'sent' | 'skipped' | 'error';
  reason?: string;
}

export function generateBriefingPrompt(prefs: { technical_depth?: string; primary_domain?: string }): string {
  const depth = prefs.technical_depth ?? 'high-level';
  const domain = prefs.primary_domain ?? 'general';
  return (
    `You are a personal AI assistant delivering a morning briefing.\n` +
    `User preferences: technical_depth=${depth}, primary_domain=${domain}.\n\n` +
    `Generate a concise, engaging morning briefing (max 200 words) tailored to these preferences.\n` +
    `Include: 1 relevant tech tip for their domain, 1 motivational thought, today\'s date.\n` +
    `Match the tone to their depth preference — ${depth === 'detailed' ? 'technical and specific' : 'concise and clear'}.\n` +
    `Format for WhatsApp (use *bold* for headings, no markdown headers).`
  );
}

async function getUserIds(docClient: DynamoDBDocumentClient, table: string): Promise<string[]> {
  const userIds = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(new ScanCommand({
      TableName: table,
      ProjectionExpression: 'userId',
      ExclusiveStartKey: lastKey as any,
    }));
    for (const item of result.Items ?? []) {
      const id = item['userId']?.S ?? (item as any)['userId'];
      if (id && id !== 'CORPORATE') userIds.add(id);
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return [...userIds];
}

async function getUserPrefs(
  docClient: DynamoDBDocumentClient,
  table: string,
  userId: string,
): Promise<{ technical_depth?: string; primary_domain?: string } | null> {
  const [depthItem, domainItem] = await Promise.all([
    docClient.send(new GetCommand({ TableName: table, Key: { userId, preferenceKey: 'technical_depth' } })),
    docClient.send(new GetCommand({ TableName: table, Key: { userId, preferenceKey: 'primary_domain' } })),
  ]);
  const depth = (depthItem.Item as any)?.preferenceValue as string | undefined;
  const domain = (domainItem.Item as any)?.preferenceValue as string | undefined;
  if (!depth && !domain) return null;
  return { technical_depth: depth, primary_domain: domain };
}

export async function sendDailyBriefings(config: NotificationConfig): Promise<BriefingResult[]> {
  const docClient = DynamoDBDocumentClient.from(config.dynamoClient);
  const results: BriefingResult[] = [];

  let userIds: string[];
  try {
    userIds = await getUserIds(docClient, config.userPreferencesTable);
  } catch (e) {
    console.error('[notification] Failed to scan users:', e);
    return [{ userId: '*', status: 'error', reason: e instanceof Error ? e.message : String(e) }];
  }

  for (const userId of userIds) {
    try {
      const prefs = await getUserPrefs(docClient, config.userPreferencesTable, userId);
      if (!prefs) {
        results.push({ userId, status: 'skipped', reason: 'no_preferences' });
        continue;
      }
      const prompt = generateBriefingPrompt(prefs);
      const content = await config.invokeModel(prompt);
      if (!content) {
        results.push({ userId, status: 'error', reason: 'empty_model_response' });
        continue;
      }
      const message = JSON.stringify({
        message_id: randomUUID(),
        user_id: userId,
        content,
        timestamp: new Date().toISOString(),
        metadata: { source: 'daily_briefing' },
      });
      await config.redisClient.lpush(`queue:agent:${userId}:inbound`, message);
      await config.redisClient.expire(`queue:agent:${userId}:inbound`, 3600);
      results.push({ userId, status: 'sent' });
    } catch (e) {
      results.push({ userId, status: 'error', reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
