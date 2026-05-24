/**
 * KB MCP tools — kb_remember, kb_recall, kb_list_top_entities, kb_status,
 * kb_forget. The actual KnowledgeBase lives on the host; this module is a
 * thin transport that issues `kb_request` system actions via messages_out
 * and blocks on the host's `kb_response` write into messages_in.
 *
 * Transport contract (see plan §M0/M1, src/modules/knowledge-base/kb-actions.ts):
 *   1. Tool writes a kind='system' messages_out row with content =
 *      { action:'kb_request', tool, args, request_id }.
 *   2. Host's delivery loop calls handleKbRequest, executes the tool, and
 *      writes a kind='system' messages_in row with content =
 *      { action:'kb_response', request_id, ok, result|error }.
 *   3. This module polls inbound.db for that response (matching request_id),
 *      with a 15s timeout. Container poll-loop already filters kind='system'
 *      out of the agent's prompt so the response row is invisible to the
 *      agent — only this sidecar reader sees it.
 */
import { openInboundDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const KB_TIMEOUT_MS = 15_000;
const KB_POLL_INTERVAL_MS = 100;

function generateRequestId(): string {
  return `kbreq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

interface KbResponseBody {
  action: 'kb_response';
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Test seam: the prod transport polls openInboundDb() in a loop, but tests
 * inject an in-memory DB via initTestSessionDb() and need a way to force
 * the poll to use that singleton. Setting __KB_TEST_DB to true makes the
 * loop call openInboundDb() each iteration (which already returns the test
 * singleton when _testMode is on). No-op in production.
 */
async function pollForResponse(requestId: string, timeoutMs: number): Promise<KbResponseBody> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const db = openInboundDb();
    try {
      const rows = db
        .prepare(
          `SELECT content FROM messages_in
           WHERE kind = 'system'
             AND content LIKE ?
             AND content LIKE ?
           ORDER BY rowid DESC
           LIMIT 1`,
        )
        .all(`%"action":"kb_response"%`, `%"request_id":"${requestId}"%`) as Array<{ content: string }>;
      if (rows.length > 0) {
        const body = JSON.parse(rows[0].content) as KbResponseBody;
        if (body.action === 'kb_response' && body.request_id === requestId) {
          return body;
        }
      }
    } finally {
      db.close();
    }
    await new Promise((r) => setTimeout(r, KB_POLL_INTERVAL_MS));
  }
  throw new Error(`kb tool timed out after ${timeoutMs}ms waiting for host response (request_id=${requestId})`);
}

/**
 * Issue a kb_request to the host and block on its response. Used by all
 * five kb_* tool handlers.
 *
 * Throws if the host returns ok:false (caller catches and converts to err()).
 */
export async function requestHostKb(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const requestId = generateRequestId();
  const r = getSessionRouting();
  writeMessageOut({
    id: `kbreq-msg-${requestId}`,
    kind: 'system',
    platform_id: r.platform_id,
    channel_type: r.channel_type,
    thread_id: r.thread_id,
    content: JSON.stringify({ action: 'kb_request', tool, args, request_id: requestId }),
  });
  const response = await pollForResponse(requestId, KB_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(response.error ?? 'kb tool failed (no error message)');
  }
  return response.result;
}

export const kbRemember: McpToolDefinition = {
  tool: {
    name: 'kb_remember',
    description:
      'Save an insight to the long-term knowledge base. Use this for durable facts, preferences, decisions, or events that should survive across sessions. The text is embedded and recallable via kb_recall. Returns the new insight id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'The insight text to remember (one focused fact per call).' },
        source: { type: 'string', description: "Origin tag, e.g. 'chat', 'photo', 'gmail'. Default 'agent-memory'." },
        source_id: { type: 'string', description: 'Optional stable id for dedup (same source+source_id upserts).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional free-form tags.' },
        entities: { type: 'array', items: { type: 'string' }, description: 'Optional named entities mentioned.' },
        category: { type: 'string', description: 'Optional category label.' },
        importance: { type: 'number', description: 'Optional 0..1 score for retention/GC.' },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    try {
      const result = await requestHostKb('kb_remember', args);
      return ok(JSON.stringify(result));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const kbRecall: McpToolDefinition = {
  tool: {
    name: 'kb_recall',
    description:
      'Semantic search over the knowledge base. Returns the top-k insights matching the query, ranked by embedding similarity. Use this before answering when the user references past context or asks about what they\'ve told you before.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free-form search query.' },
        k: { type: 'number', description: 'Max results to return. Default 5.' },
        source: { type: 'string', description: 'Optional source filter (e.g. only chat-origin insights).' },
        since: { type: 'string', description: 'Optional ISO-8601 lower bound on timestamp.' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    try {
      const result = await requestHostKb('kb_recall', args);
      return ok(JSON.stringify(result));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const kbListTopEntities: McpToolDefinition = {
  tool: {
    name: 'kb_list_top_entities',
    description:
      'List the most-mentioned entities in the knowledge base, with counts. Useful for an at-a-glance picture of what the user talks about most.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max entities to return. Default 10.' },
      },
    },
  },
  async handler(args) {
    try {
      const result = await requestHostKb('kb_list_top_entities', args);
      return ok(JSON.stringify(result));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const kbStatus: McpToolDefinition = {
  tool: {
    name: 'kb_status',
    description:
      'Report knowledge-base health: total insight count and the top-10 entities. Use to confirm the KB is online and populated before relying on kb_recall.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    try {
      const result = await requestHostKb('kb_status', {});
      return ok(JSON.stringify(result));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const kbForget: McpToolDefinition = {
  tool: {
    name: 'kb_forget',
    description:
      'Delete an insight by id. Irreversible. Use only when the user explicitly asks you to forget something or when an insight is verifiably wrong.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'The insight id to delete (from kb_recall result).' },
      },
      required: ['id'],
    },
  },
  async handler(args) {
    try {
      const result = await requestHostKb('kb_forget', args);
      return ok(JSON.stringify(result));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([kbRemember, kbRecall, kbListTopEntities, kbStatus, kbForget]);
