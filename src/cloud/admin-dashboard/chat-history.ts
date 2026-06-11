/**
 * Chat history for admin dashboard.
 *
 * Reads `nanoclaw-chat-messages` DynamoDB table directly.
 * Schema (per cloud-responder.ts):
 *   userId: string (partition)
 *   timestamp: string ISO8601 (sort)
 *   role: 'user' | 'assistant'
 *   text: string
 *   ttl: number (epoch seconds)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION ?? 'ap-southeast-1';
const TABLE = process.env.MESSAGES_TABLE ?? 'nanoclaw-chat-messages';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

export interface ChatMessage {
    userId: string;
    timestamp: string;
    role: 'user' | 'assistant';
    text: string;
}

export interface ChatUser {
    userId: string;
    lastMessageAt: string;
    lastMessagePreview: string;
    lastMessageRole: 'user' | 'assistant';
    messageCount: number;
}

export interface ChatUsersResponse {
    users: ChatUser[];
    totalUsers: number;
}

export interface ChatHistoryResponse {
    userId: string;
    messages: ChatMessage[];
    hasMore: boolean;
}

/**
 * List all distinct users with their latest message preview.
 *
 * Uses a Scan (cheap for low-volume tables); upgrades to GSI later
 * when message volume grows.
 */
export async function listChatUsers(limit = 50): Promise<ChatUsersResponse> {
    const items: Array<{ userId: string; timestamp: string; role: string; text: string }> = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    // Scan up to 5 pages of 1MB each — enough for a personal assistant.
    for (let i = 0; i < 5; i++) {
        const out = await ddb.send(new ScanCommand({
            TableName: TABLE,
            ProjectionExpression: 'userId, #ts, #r, #t',
            ExpressionAttributeNames: { '#ts': 'timestamp', '#r': 'role', '#t': 'text' },
            ExclusiveStartKey: exclusiveStartKey,
        }));
        for (const it of (out.Items ?? [])) {
            items.push(it as never);
        }
        if (!out.LastEvaluatedKey) break;
        exclusiveStartKey = out.LastEvaluatedKey;
    }

    // Group by userId, find latest per user
    const byUser = new Map<string, { latest: typeof items[0]; count: number }>();
    for (const m of items) {
        const cur = byUser.get(m.userId);
        if (!cur) {
            byUser.set(m.userId, { latest: m, count: 1 });
        } else {
            cur.count++;
            if (m.timestamp > cur.latest.timestamp) cur.latest = m;
        }
    }

    const users: ChatUser[] = Array.from(byUser.values())
        .map(({ latest, count }) => ({
            userId: latest.userId,
            lastMessageAt: latest.timestamp,
            lastMessagePreview: latest.text.length > 80 ? latest.text.slice(0, 80) + '…' : latest.text,
            lastMessageRole: latest.role as 'user' | 'assistant',
            messageCount: count,
        }))
        .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
        .slice(0, limit);

    return {
        users,
        totalUsers: byUser.size,
    };
}

/**
 * Fetch a user's chat history (chronological order, most recent N messages).
 */
export async function getChatHistory(userId: string, limit = 100): Promise<ChatHistoryResponse> {
    const out = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        ScanIndexForward: false, // newest first
        Limit: limit,
    }));

    const items = (out.Items ?? []) as ChatMessage[];
    // Reverse to chronological order for display
    items.reverse();

    return {
        userId,
        messages: items,
        hasMore: !!out.LastEvaluatedKey,
    };
}
