/**
 * Delivery action handler for KB MCP tool requests.
 *
 * The container can't reach Postgres directly; the KB lives on the host.
 * In-container `kb_*` MCP tools (container/agent-runner/src/mcp-tools/kb.ts)
 * write `kind='system'` outbound messages with action='kb_request' and a
 * request_id. This handler reads getKnowledgeBase(), executes the requested
 * tool, and writes a `kind='system'` response message back into inbound.db
 * with action='kb_response' and the same request_id.
 *
 * The container poll loop already filters kind='system' rows out before the
 * agent sees them (poll-loop.ts L73), so kb_response rows bypass the agent
 * entirely — the MCP tool's sidecar reader picks them up directly.
 *
 * Permission gate (v1, plan §2.4): only sessions belonging to the
 * `pocketclaw` agent group may invoke kb_* tools. Other agent groups get
 * a structured refusal back (the response still ships, with ok:false).
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getKnowledgeBase } from './index.js';
import type { Insight, KnowledgeBase, RecallOptions } from './index.js';

/** Hard-coded gate for v1. Future: lift into a wiring table. */
const ALLOWED_AGENT_GROUPS = new Set<string>(['pocketclaw']);

/**
 * Test seam: lets unit tests inject a stub KnowledgeBase without spinning
 * up Postgres. Production code never touches this — getKnowledgeBase() is
 * the singleton path.
 */
let _kbResolver: () => Promise<KnowledgeBase> = getKnowledgeBase;
export function _setKbResolverForTest(fn: () => Promise<KnowledgeBase>): void {
  _kbResolver = fn;
}
export function _resetKbResolverForTest(): void {
  _kbResolver = getKnowledgeBase;
}

interface KbResponseBody {
  action: 'kb_response';
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function generateResponseId(): string {
  return `kbres-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function executeTool(tool: string, args: Record<string, unknown>, kb: KnowledgeBase): Promise<unknown> {
  switch (tool) {
    case 'kb_remember': {
      const text = args.text;
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error('kb_remember: `text` is required and must be a non-empty string');
      }
      const insight: Insight = {
        text,
        source: typeof args.source === 'string' ? args.source : 'agent-memory',
        source_id: typeof args.source_id === 'string' ? args.source_id : undefined,
        tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
        entities: Array.isArray(args.entities) ? (args.entities as string[]) : undefined,
        category: typeof args.category === 'string' ? args.category : undefined,
        importance: typeof args.importance === 'number' ? (args.importance as number) : undefined,
      };
      const { id, created } = await kb.store(insight);
      return { id, created };
    }
    case 'kb_recall': {
      const query = args.query;
      if (typeof query !== 'string' || query.length === 0) {
        throw new Error('kb_recall: `query` is required and must be a non-empty string');
      }
      const opts: RecallOptions = {};
      if (typeof args.k === 'number') opts.k = args.k;
      if (typeof args.source === 'string') opts.source = args.source;
      if (typeof args.since === 'string') opts.since = new Date(args.since);
      const insights = await kb.recall(query, opts);
      return {
        insights: insights.map((i) => ({
          id: i.id,
          text: i.text,
          source: i.source,
          source_id: i.source_id,
          tags: i.tags,
          entities: i.entities,
          category: i.category,
          importance: i.importance,
        })),
      };
    }
    case 'kb_list_top_entities': {
      const limit = typeof args.limit === 'number' ? args.limit : 10;
      const entities = await kb.topEntities(limit);
      return { entities };
    }
    case 'kb_status': {
      const total = await kb.count();
      const topEntities = await kb.topEntities(10);
      return { total, topEntities };
    }
    case 'kb_forget': {
      const id = args.id;
      if (typeof id !== 'number') {
        throw new Error('kb_forget: `id` is required and must be a number');
      }
      await kb.forget(id);
      return { id, forgotten: true };
    }
    default:
      throw new Error(`Unknown kb tool: ${tool}`);
  }
}

/**
 * Delivery action handler. Registered against `kb_request` in
 * src/modules/knowledge-base/register.ts.
 *
 * On entry: `content.tool` is the tool name, `content.args` is the args
 * record, `content.request_id` is the correlation token.
 * On exit: a kind='system' message is appended to inbound.db with
 * action='kb_response', the same request_id, and either
 * `{ ok: true, result }` or `{ ok: false, error }`.
 */
export async function handleKbRequest(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const requestId = content.request_id as string | undefined;
  const tool = content.tool as string | undefined;
  const args = (content.args as Record<string, unknown> | undefined) ?? {};

  if (!requestId || !tool) {
    log.warn('kb_request missing request_id or tool', { sessionId: session.id, requestId, tool });
    return;
  }

  let response: KbResponseBody;
  if (!ALLOWED_AGENT_GROUPS.has(session.agent_group_id)) {
    response = {
      action: 'kb_response',
      request_id: requestId,
      ok: false,
      error: `kb_* tools are restricted to the pocketclaw agent group (this is "${session.agent_group_id}").`,
    };
    log.warn('kb_request refused by permission gate', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      tool,
      requestId,
    });
  } else {
    const startedAt = Date.now();
    try {
      const kb = await _kbResolver();
      const result = await executeTool(tool, args, kb);
      response = { action: 'kb_response', request_id: requestId, ok: true, result };
      log.info('kb_request handled', {
        sessionId: session.id,
        tool,
        requestId,
        latencyMs: Date.now() - startedAt,
      });
    } catch (err) {
      response = {
        action: 'kb_response',
        request_id: requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      log.warn('kb_request failed', {
        sessionId: session.id,
        tool,
        requestId,
        latencyMs: Date.now() - startedAt,
        error: response.error,
      });
    }
  }

  writeSessionMessage(session.agent_group_id, session.id, {
    id: generateResponseId(),
    kind: 'system',
    timestamp: new Date().toISOString(),
    content: JSON.stringify(response),
    trigger: 0,
  });
}
