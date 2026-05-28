/**
 * Clawd — Slack ingestion (PRD §17.2)
 *
 * Uses user token (xoxp-) to read channels as the user themselves.
 * NOT a bot — acts as the user, can read all channels user has joined.
 *
 * Features:
 *   - Ingest messages from configured channels → mnemon facts
 *   - Search Slack history via /slack-search <query>
 *   - Read threads for full context
 *
 * Auth: SLACK_USER_TOKEN env var (xoxp-...)
 * Cron: daily at 02:00 alongside other cloud ingesters.
 */

import type { CloudIngester, Fact } from './types.js';
import { stripHtml } from './types.js';

const SLACK_API = 'https://slack.com/api';

function getToken(): string {
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) throw new Error('SLACK_USER_TOKEN not set in .env');
  return token;
}

async function slackFetch(
  method: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${SLACK_API}/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error(`Slack ${method}: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}

interface SlackMessage {
  text: string;
  user: string;
  ts: string;
  thread_ts?: string;
}

interface SlackChannel {
  id: string;
  name: string;
  is_member: boolean;
}

/**
 * List all channels the user is a member of.
 */
export async function listMyChannels(): Promise<SlackChannel[]> {
  const data = await slackFetch('conversations.list', {
    types: 'public_channel,private_channel',
    limit: '200',
    exclude_archived: 'true',
  });
  const channels = (data.channels as SlackChannel[]) ?? [];
  return channels.filter((c) => c.is_member);
}

/**
 * Get user display names for a list of user IDs.
 */
const userCache = new Map<string, string>();
async function resolveUser(userId: string): Promise<string> {
  if (userCache.has(userId)) return userCache.get(userId)!;
  try {
    const data = await slackFetch('users.info', { user: userId });
    const user = data.user as { real_name?: string; name?: string } | undefined;
    const name = user?.real_name ?? user?.name ?? userId;
    userCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

export class SlackChannelIngester implements CloudIngester {
  readonly source = 'slack';

  constructor(
    private readonly channelIds?: string[],
    private readonly maxMessages = 50,
  ) {}

  async fetch(since: Date): Promise<{ facts: Fact[]; errors: string[] }> {
    const facts: Fact[] = [];
    const errors: string[] = [];

    try {
      // Get channels to ingest
      let channels: SlackChannel[];
      if (this.channelIds?.length) {
        channels = (await listMyChannels()).filter((c) => this.channelIds!.includes(c.id) || this.channelIds!.includes(c.name));
      } else {
        // Default: all channels user joined (capped at 10 most active)
        channels = (await listMyChannels()).slice(0, 10);
      }

      const oldest = Math.floor(since.getTime() / 1000).toString();

      for (const channel of channels) {
        try {
          const data = await slackFetch('conversations.history', {
            channel: channel.id,
            oldest,
            limit: String(this.maxMessages),
          });

          const messages = (data.messages as SlackMessage[]) ?? [];
          for (const msg of messages) {
            if (!msg.text || msg.text.startsWith('<!') || msg.text.length < 5) continue;

            const userName = await resolveUser(msg.user);
            const cleanText = stripHtml(msg.text).slice(0, 500);
            const ts = new Date(parseFloat(msg.ts) * 1000);

            facts.push({
              text: `Slack #${channel.name} — ${userName}: ${cleanText}`,
              source: 'slack',
              sourceId: `${channel.id}:${msg.ts}`,
              occurredAt: ts,
              meta: {
                channel: channel.name,
                channelId: channel.id,
                threadTs: msg.thread_ts ?? '',
              },
            });
          }
        } catch (e) {
          errors.push(`slack #${channel.name}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      errors.push(`slack-channels: ${(e as Error).message}`);
    }

    return { facts, errors };
  }
}

/**
 * Search Slack messages matching a query. Used by /slack-search skill.
 */
export async function searchSlack(
  query: string,
  count = 20,
): Promise<{ results: Fact[]; error?: string }> {
  try {
    const data = await slackFetch('search.messages', {
      query,
      count: String(count),
      sort: 'timestamp',
      sort_dir: 'desc',
    });

    const matches = (data.messages as { matches?: SlackMessage[] })?.matches ?? [];
    const results: Fact[] = matches.map((msg) => ({
      text: stripHtml(msg.text).slice(0, 500),
      source: 'slack-search',
      sourceId: msg.ts,
      occurredAt: new Date(parseFloat(msg.ts) * 1000),
    }));

    return { results };
  } catch (e) {
    return { results: [], error: (e as Error).message };
  }
}

export const slackIngesters: CloudIngester[] = [new SlackChannelIngester()];
