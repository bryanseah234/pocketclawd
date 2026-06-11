/**
 * Session Initialisation — orchestrates system-prompt loading, persona
 * probing, and final prompt assembly at the start of every agent session.
 *
 * This module is intentionally side-effect-free at import time so it can
 * be unit-tested without a live AWS / Redis environment.
 *
 * Integration hook (TODO for container wiring):
 *   In container/agent-runner/src/index.ts (or equivalent poll-loop entry),
 *   replace the bare `buildSystemPromptAddendum()` call with:
 *
 *     const init = await initSession({ userId, redis, loader, addendum });
 *     // init.systemPrompt  → pass to Claude provider
 *     // init.isNewUser     → if true, activate discovery_skill flow
 *
 * Requirements: 1.1, 2.1, 2.2, 2.3, 9.2, 9.3, 9.4, 10.4
 */

import { SystemPromptLoader, SystemPromptTemplate } from './system-prompt-loader.js';
import { assembleSystemPrompt } from './system-prompt-assembler.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** Minimal Redis-compatible interface (async lpush / brpop). */
export interface RedisLike {
    lpush(key: string, ...values: string[]): Promise<number>;
    brpop(key: string, timeout: number): Promise<[string, string] | null>;
}

export interface UserPersonaContext {
    isNewUser: boolean;
    technicalDepth: string | null;   // "detailed" | "high-level"
    primaryDomain: string | null;    // "frontend" | "infrastructure" | "data"
}

export interface SessionInitOptions {
    userId: string;
    redis: RedisLike;
    loader: SystemPromptLoader;
    /** Optional runtime addendum text (tool context, etc.). */
    runtimeAddendum?: string;
    /** Override the response queue key for testing. */
    responseQueueKey?: string;
    /** Timeout (ms) for the DataGateway preference probe. Default 5000. */
    probeTimeoutMs?: number;
}

export interface SessionInitResult {
    systemPrompt: string;
    template: SystemPromptTemplate;
    persona: UserPersonaContext;
    isNewUser: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DATA_GATEWAY_QUEUE = 'queue:orchestrator:data_gateway';
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

// ── Persona probe ─────────────────────────────────────────────────────────

/**
 * Query the DataGateway Worker for stored user preferences.
 * Fail-open: any error → treat as new user.
 */
export async function probePersona(
    redis: RedisLike,
    userId: string,
    opts?: { responseQueueKey?: string; timeoutMs?: number },
): Promise<UserPersonaContext> {
    const failOpen: UserPersonaContext = {
        isNewUser: true,
        technicalDepth: null,
        primaryDomain: null,
    };

    try {
        const requestId = `probe-${userId}-${Date.now()}`;
        const responseKey = opts?.responseQueueKey ?? `queue:agent:${userId}:responses`;
        const timeoutSec = Math.ceil((opts?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS) / 1000);

        await redis.lpush(
            DATA_GATEWAY_QUEUE,
            JSON.stringify({
                action: 'get_user_preference',
                user_id: userId,
                request_id: requestId,
                response_queue: responseKey,
            }),
        );

        const reply = await redis.brpop(responseKey, timeoutSec);
        if (!reply) return failOpen; // timeout

        const data = JSON.parse(reply[1]) as Record<string, unknown>;
        const prefs = data.preferences as Record<string, unknown> | null | undefined;

        if (!prefs || !prefs['discoveryCompleted']) return failOpen;

        return {
            isNewUser: false,
            technicalDepth: (prefs['technical_depth'] as string) ?? null,
            primaryDomain: (prefs['primary_domain'] as string) ?? null,
        };
    } catch {
        return failOpen;
    }
}

// ── Prompt assembly with persona ──────────────────────────────────────────

/**
 * Build the final system prompt by injecting persona context into the
 * runtime addendum section before assembly.
 */
export function buildPersonaAddendum(
    persona: UserPersonaContext,
    runtimeAddendum?: string,
): string {
    const parts: string[] = [];

    if (persona.isNewUser) {
        parts.push(
            '## Current User Context\n' +
            'This is a new user. Activate the discovery phase: ' +
            'ask for their technical depth preference and primary domain before answering.',
        );
    } else {
        const depth = persona.technicalDepth ?? 'balanced';
        const domain = persona.primaryDomain ?? 'general';
        parts.push(
            `## Current User Context\n` +
            `Returning user. Apply silently:\n` +
            `- Technical depth: ${depth}\n` +
            `- Primary domain: ${domain}`,
        );
    }

    if (runtimeAddendum?.trim()) parts.push(runtimeAddendum.trim());

    return parts.join('\n\n');
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Initialise a session: load system prompt + probe persona + assemble.
 *
 * Call once at the start of each session (before invoking Claude).
 */
export async function initSession(opts: SessionInitOptions): Promise<SessionInitResult> {
    const { userId, redis, loader, runtimeAddendum, responseQueueKey, probeTimeoutMs } = opts;

    // 1. Load system prompt template (cached / hot-reload)
    const template = await loader.loadTemplate();

    // 2. Probe user persona (fail-open)
    const persona = await probePersona(redis, userId, {
        responseQueueKey,
        timeoutMs: probeTimeoutMs,
    });

    // 3. Build addendum with persona context
    const addendum = buildPersonaAddendum(persona, runtimeAddendum);

    // 4. Assemble final system prompt
    const systemPrompt = assembleSystemPrompt(template, addendum);

    return { systemPrompt, template, persona, isNewUser: persona.isNewUser };
}
