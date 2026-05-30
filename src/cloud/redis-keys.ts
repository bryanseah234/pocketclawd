/**
 * Canonical Redis key namespace — the single source of truth for every queue
 * and channel name shared between the orchestrator (TS) and the sub-agent
 * (Python, see container/sub-agent/src/redis_keys.py — keep in lockstep).
 *
 * Resolves t4-25 (shared namespace constants) and fixes the dispatch-key
 * mismatch where router.ts enqueued to `queue:agent:dispatch:inbound` while
 * the worker-pool sub-agent BRPOPs `queue:agent:dispatch`.
 *
 * KEY CONTRACT (DO NOT CHANGE without updating redis_keys.py + a migration):
 *
 *   Worker-pool inbound (cloud):   queue:agent:dispatch
 *   Per-user inbound (on-prem):    queue:agent:{userId}:inbound
 *   Orchestrator responses:        queue:orchestrator:responses
 *   DataGateway requests:          queue:orchestrator:data_gateway
 *   Per-user DLQ:                  queue:agent:{userId}:dlq
 *   DG response (per request):     queue:agent:{userId}:dg_response:{requestId}
 *   Token response (per request):  queue:agent:{userId}:token_response:{requestId}
 *   Admin shared inbound:          queue:agent:shared:inbound
 */

/** Sentinel userId meaning "use the shared worker-pool dispatch queue". */
export const DISPATCH_SENTINEL = 'dispatch';

export const REDIS_KEYS = {
    /** Shared worker-pool inbound queue (cloud mode). */
    workerPoolInbound: 'queue:agent:dispatch',
    /** Sub-agent → orchestrator response queue. */
    orchestratorResponses: 'queue:orchestrator:responses',
    /** Orchestrator DataGateway request queue. */
    dataGateway: 'queue:orchestrator:data_gateway',
    /** Admin dashboard shared inbound queue. */
    adminSharedInbound: 'queue:agent:shared:inbound',
} as const;

/**
 * Inbound queue key for an agent.
 * - In worker-pool / cloud mode the caller passes the DISPATCH_SENTINEL and we
 *   return the single shared queue the ECS workers consume.
 * - Otherwise (on-prem per-user containers) we return the per-user inbound key.
 */
export function agentInboundKey(userId: string): string {
    if (userId === DISPATCH_SENTINEL) {
        return REDIS_KEYS.workerPoolInbound;
    }
    return `queue:agent:${userId}:inbound`;
}

export function orchestratorResponseKey(): string {
    return REDIS_KEYS.orchestratorResponses;
}

export function dlqKey(userId: string): string {
    return `queue:agent:${userId}:dlq`;
}
