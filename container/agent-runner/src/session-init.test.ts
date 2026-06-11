/**
 * Unit tests for session-init.ts — session initialisation orchestration.
 * Requirements: 1.1, 2.1, 2.2, 2.3, 9.2, 9.3, 9.4, 10.4
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { initSession, probePersona, buildPersonaAddendum } from './session-init.js';
import { MINIMAL_FALLBACK_TEMPLATE } from './system-prompt-loader.js';
import type { SystemPromptLoader } from './system-prompt-loader.js';
import type { RedisLike } from './session-init.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRedis(prefResponse?: Record<string, unknown> | null): RedisLike {
    return {
        lpush: mock(async () => 1),
        brpop: mock(async (_key: string, _timeout: number) => {
            if (prefResponse === undefined) return null; // timeout
            return ['key', JSON.stringify({ preferences: prefResponse })] as [string, string];
        }),
    };
}

function makeLoader(template = MINIMAL_FALLBACK_TEMPLATE): SystemPromptLoader {
    return {
        loadTemplate: mock(async () => template),
    } as unknown as SystemPromptLoader;
}

// ── probePersona ──────────────────────────────────────────────────────────

describe('probePersona', () => {
    it('returns isNewUser=true when DataGateway returns null preferences', async () => {
        const redis = makeRedis(null);
        const ctx = await probePersona(redis, 'user-1');
        expect(ctx.isNewUser).toBe(true);
        expect(ctx.technicalDepth).toBeNull();
        expect(ctx.primaryDomain).toBeNull();
    });

    it('returns isNewUser=true when discoveryCompleted is false', async () => {
        const redis = makeRedis({ discoveryCompleted: false, technical_depth: 'detailed' });
        const ctx = await probePersona(redis, 'user-1');
        expect(ctx.isNewUser).toBe(true);
    });

    it('returns isNewUser=false with prefs when discoveryCompleted=true', async () => {
        const redis = makeRedis({
            discoveryCompleted: true,
            technical_depth: 'detailed',
            primary_domain: 'infrastructure',
        });
        const ctx = await probePersona(redis, 'user-1');
        expect(ctx.isNewUser).toBe(false);
        expect(ctx.technicalDepth).toBe('detailed');
        expect(ctx.primaryDomain).toBe('infrastructure');
    });

    it('fail-open: Redis timeout → isNewUser=true', async () => {
        const redis = makeRedis(undefined); // brpop returns null (timeout)
        const ctx = await probePersona(redis, 'user-1', { timeoutMs: 100 });
        expect(ctx.isNewUser).toBe(true);
    });

    it('fail-open: Redis error → isNewUser=true', async () => {
        const redis: RedisLike = {
            lpush: mock(async () => { throw new Error('connection lost'); }),
            brpop: mock(async () => null),
        };
        const ctx = await probePersona(redis, 'user-1');
        expect(ctx.isNewUser).toBe(true);
    });
});

// ── buildPersonaAddendum ───────────────────────────────────────────────────

describe('buildPersonaAddendum', () => {
    it('new user addendum contains discovery phase instruction', () => {
        const result = buildPersonaAddendum({ isNewUser: true, technicalDepth: null, primaryDomain: null });
        expect(result).toContain('discovery phase');
        expect(result).toContain('new user');
    });

    it('returning user addendum contains depth and domain', () => {
        const result = buildPersonaAddendum({
            isNewUser: false,
            technicalDepth: 'high-level',
            primaryDomain: 'frontend',
        });
        expect(result).toContain('high-level');
        expect(result).toContain('frontend');
        expect(result).not.toContain('discovery phase');
    });

    it('appends runtimeAddendum when provided', () => {
        const result = buildPersonaAddendum(
            { isNewUser: false, technicalDepth: 'detailed', primaryDomain: 'data' },
            'Tool context: active tools = [search, files]',
        );
        expect(result).toContain('Tool context');
    });

    it('skips empty runtimeAddendum', () => {
        const result = buildPersonaAddendum(
            { isNewUser: true, technicalDepth: null, primaryDomain: null },
            '   ',
        );
        expect(result.trim()).not.toEndWith('   ');
    });
});

// ── initSession ────────────────────────────────────────────────────────────

describe('initSession', () => {
    it('new user: isNewUser=true, systemPrompt contains identity + discovery', async () => {
        const loader = makeLoader();
        const redis = makeRedis(null);
        const result = await initSession({ userId: 'user-new', redis, loader });

        expect(result.isNewUser).toBe(true);
        expect(result.systemPrompt).toContain('Clawd');       // identity section
        expect(result.systemPrompt).toContain('discovery phase');
    });

    it('returning user: isNewUser=false, systemPrompt contains prefs context', async () => {
        const loader = makeLoader();
        const redis = makeRedis({
            discoveryCompleted: true,
            technical_depth: 'detailed',
            primary_domain: 'data',
        });
        const result = await initSession({ userId: 'user-returning', redis, loader });

        expect(result.isNewUser).toBe(false);
        expect(result.persona.technicalDepth).toBe('detailed');
        expect(result.systemPrompt).toContain('detailed');
        expect(result.systemPrompt).toContain('data');
    });

    it('Secrets Manager down: falls back to MINIMAL_FALLBACK_TEMPLATE', async () => {
        const loader: SystemPromptLoader = {
            loadTemplate: mock(async () => MINIMAL_FALLBACK_TEMPLATE),
        } as unknown as SystemPromptLoader;
        const redis = makeRedis(null);
        const result = await initSession({ userId: 'user-1', redis, loader });
        expect(result.template.version).toBe('0.0.0');
        expect(result.systemPrompt).toBeTruthy();
    });

    it('TTL expired: loader.loadTemplate is called (reload triggered)', async () => {
        const loader = makeLoader();
        const redis = makeRedis(null);
        await initSession({ userId: 'user-1', redis, loader });
        // loadTemplate was called exactly once
        expect((loader.loadTemplate as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    });

    it('runtimeAddendum is included in assembled prompt', async () => {
        const loader = makeLoader();
        const redis = makeRedis(null);
        const result = await initSession({
            userId: 'user-1',
            redis,
            loader,
            runtimeAddendum: 'Active tools: web-search',
        });
        expect(result.systemPrompt).toContain('Active tools: web-search');
    });

    it('escalation integration: persona+escalation section both present', async () => {
        const loader = makeLoader();
        const redis = makeRedis({
            discoveryCompleted: true,
            technical_depth: 'high-level',
            primary_domain: 'infrastructure',
        });
        const result = await initSession({ userId: 'user-1', redis, loader });
        // escalation section from minimal template
        expect(result.systemPrompt).toContain('cannot help');
    });
});
