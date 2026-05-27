/**
 * Tests for the System Prompt Template Loader.
 *
 * Verifies:
 * - Template loading from Secrets Manager (app-config key and standalone)
 * - In-memory caching with TTL
 * - shouldReload logic
 * - Fallback to cached template when Secrets Manager is unavailable
 * - Fallback to hardcoded minimal prompt when no cache exists
 * - Template validation
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

import {
    SystemPromptLoader,
    shouldReload,
    MINIMAL_FALLBACK_TEMPLATE,
    type SystemPromptTemplate,
    type CachedPrompt,
} from './system-prompt-loader.js';

// ── Test Helpers ──

function makeValidTemplate(overrides?: Partial<SystemPromptTemplate>): SystemPromptTemplate {
    return {
        version: '1.0.0',
        sections: {
            identity: 'You are Clawd, a senior specialist AI assistant.',
            onboarding: 'Ask two discovery questions for new users.',
            responseStyle: 'Be concise. Use numbered lists.',
            guardrails: 'Never say "As an AI...".',
            confidence: 'Answer directly when confident.',
            coding: 'Use fenced code blocks.',
            escalation: 'Inform user and suggest next steps.',
        },
        updatedAt: '2024-06-01T12:00:00Z',
        ...overrides,
    };
}

function makeMockClient(responses: Array<{ SecretString?: string; error?: Error }>) {
    let callIndex = 0;
    const sendFn = mock(async () => {
        const response = responses[callIndex++];
        if (!response) throw new Error('No more mock responses');
        if (response.error) throw response.error;
        return { SecretString: response.SecretString };
    });

    return {
        send: sendFn,
        // Satisfy the SecretsManagerClient interface minimally
        config: {},
        destroy: () => { },
        middlewareStack: {} as any,
    } as any;
}

// ── shouldReload ──

describe('shouldReload', () => {
    it('returns true when TTL has expired', () => {
        const cached: CachedPrompt = {
            template: makeValidTemplate(),
            loadedAt: Date.now() - 400_000, // 400s ago
            ttlMs: 300_000, // 5 min TTL
        };
        expect(shouldReload(cached)).toBe(true);
    });

    it('returns false when within TTL', () => {
        const cached: CachedPrompt = {
            template: makeValidTemplate(),
            loadedAt: Date.now() - 100_000, // 100s ago
            ttlMs: 300_000, // 5 min TTL
        };
        expect(shouldReload(cached)).toBe(false);
    });

    it('returns true when loadedAt equals TTL boundary', () => {
        const now = Date.now();
        const cached: CachedPrompt = {
            template: makeValidTemplate(),
            loadedAt: now - 300_001, // Just past TTL
            ttlMs: 300_000,
        };
        expect(shouldReload(cached)).toBe(true);
    });

    it('returns false when just loaded', () => {
        const cached: CachedPrompt = {
            template: makeValidTemplate(),
            loadedAt: Date.now(),
            ttlMs: 300_000,
        };
        expect(shouldReload(cached)).toBe(false);
    });
});

// ── SystemPromptLoader ──

describe('SystemPromptLoader', () => {
    describe('loadTemplate — from app-config secret', () => {
        it('loads template from systemPromptTemplate key in app-config', async () => {
            const template = makeValidTemplate();
            const mockClient = makeMockClient([
                { SecretString: JSON.stringify({ systemPromptTemplate: template }) },
            ]);

            const loader = new SystemPromptLoader({ client: mockClient });
            const result = await loader.loadTemplate();

            expect(result).toEqual(template);
            expect(mockClient.send).toHaveBeenCalledTimes(1);
        });

        it('handles systemPromptTemplate as a JSON string within app-config', async () => {
            const template = makeValidTemplate();
            const mockClient = makeMockClient([
                { SecretString: JSON.stringify({ systemPromptTemplate: JSON.stringify(template) }) },
            ]);

            const loader = new SystemPromptLoader({ client: mockClient });
            const result = await loader.loadTemplate();

            expect(result).toEqual(template);
        });
    });

    describe('loadTemplate — from standalone secret', () => {
        it('falls back to standalone secret when app-config has no systemPromptTemplate key', async () => {
            const template = makeValidTemplate({ version: '2.0.0' });
            const mockClient = makeMockClient([
                // app-config exists but has no systemPromptTemplate key
                { SecretString: JSON.stringify({ redis_host: 'localhost' }) },
                // standalone secret
                { SecretString: JSON.stringify(template) },
            ]);

            const loader = new SystemPromptLoader({ client: mockClient });
            const result = await loader.loadTemplate();

            expect(result.version).toBe('2.0.0');
            expect(mockClient.send).toHaveBeenCalledTimes(2);
        });

        it('falls back to standalone secret when app-config fetch fails', async () => {
            const template = makeValidTemplate({ version: '3.0.0' });
            const mockClient = makeMockClient([
                // app-config fetch fails
                { error: new Error('Access denied') },
                // standalone secret succeeds
                { SecretString: JSON.stringify(template) },
            ]);

            const loader = new SystemPromptLoader({ client: mockClient });
            const result = await loader.loadTemplate();

            expect(result.version).toBe('3.0.0');
        });
    });

    describe('loadTemplate — caching', () => {
        it('returns cached template within TTL without re-fetching', async () => {
            const template = makeValidTemplate();
            const mockClient = makeMockClient([
                { SecretString: JSON.stringify({ systemPromptTemplate: template }) },
            ]);

            const loader = new SystemPromptLoader({ client: mockClient, ttlMs: 300_000 });

            const result1 = await loader.loadTemplate();
            const result2 = await loader.loadTemplate();

            expect(result1).toEqual(result2);
            expect(mockClient.send).toHaveBeenCalledTimes(1);
        });

        it('re-fetches when TTL has expired', async () => {
            const template1 = makeValidTemplate({ version: '1.0.0' });
            const template2 = makeValidTemplate({ version: '2.0.0' });
            const mockClient = makeMockClient([
                { SecretString: JSON.stringify({ systemPromptTemplate: template1 }) },
                { SecretString: JSON.stringify({ systemPromptTemplate: template2 }) },
            ]);

            // Use a very short TTL so it expires immediately
            const loader = new SystemPromptLoader({ client: mockClient, ttlMs: 1 });

            const result1 = await loader.loadTemplate();
            expect(result1.version).toBe('1.0.0');

            // Wait for TTL to expire
            await new Promise((r) => setTimeout(r, 5));

            const result2 = await loader.loadTemplate();
            expect(result2.version).toBe('2.0.0');
            expect(mockClient.send).toHaveBeenCalledTimes(2);
        });
    });

    describe('loadTemplate — fallback behavior', () => {
        it('uses stale cached template when Secrets Manager is unavailable', async () => {
            const template = makeValidTemplate({ version: '1.0.0' });
            const mockClient = makeMockClient([
                // First load succeeds
                { SecretString: JSON.stringify({ systemPromptTemplate: template }) },
                // Second load fails (both app-config and standalone)
                { error: new Error('Service unavailable') },
                { error: new Error('Service unavailable') },
            ]);

            // Use a very short TTL
            const loader = new SystemPromptLoader({ client: mockClient, ttlMs: 1 });

            // First load succeeds and caches
            const result1 = await loader.loadTemplate();
            expect(result1.version).toBe('1.0.0');

            // Wait for TTL to expire
            await new Promise((r) => setTimeout(r, 5));

            // Second load fails but returns cached version
            const result2 = await loader.loadTemplate();
            expect(result2.version).toBe('1.0.0');
        });

        it('returns hardcoded minimal template when no cache exists and fetch fails', async () => {
            const mockClient = makeMockClient([
                // Both fetches fail
                { error: new Error('Service unavailable') },
                { error: new Error('Service unavailable') },
            ]);

            const loader = new SystemPromptLoader({ client: mockClient });
            const result = await loader.loadTemplate();

            expect(result).toEqual(MINIMAL_FALLBACK_TEMPLATE);
            expect(result.version).toBe('0.0.0');
        });
    });

    describe('loadTemplate — validation', () => {
        it('rejects template with missing version', async () => {
            const invalid = { sections: makeValidTemplate().sections, updatedAt: '2024-01-01T00:00:00Z' };
            const mockClient = makeMockClient([
                // app-config fails validation
                { SecretString: JSON.stringify({ systemPromptTemplate: invalid }) },
                // standalone also fails
                { SecretString: JSON.stringify(invalid) },
            ]);

            const loader = new SystemPromptLoader({ client: mockClient });
            const result = await loader.loadTemplate();

            // Falls back to minimal since validation fails
            expect(result).toEqual(MINIMAL_FALLBACK_TEMPLATE);
        });

        it('rejects template with missing sections', async () => {
            const invalid = { version: '1.0.0', updatedAt: '2024-01-01T00:00:00Z' };
            const mockClient = makeMockClient([
                { SecretString: JSON.stringify({ systemPromptTemplate: invalid }) },
                { SecretString: JSON.stringify(invalid) },
            ]);

            const loader = new SystemPromptLoader({ client: mockClient });
            const result = await loader.loadTemplate();

            expect(result).toEqual(MINIMAL_FALLBACK_TEMPLATE);
        });

        it('rejects template with incomplete sections', async () => {
            const invalid = {
                version: '1.0.0',
                sections: { identity: 'test' }, // Missing other sections
                updatedAt: '2024-01-01T00:00:00Z',
            };
            const mockClient = makeMockClient([
                { SecretString: JSON.stringify({ systemPromptTemplate: invalid }) },
                { SecretString: JSON.stringify(invalid) },
            ]);

            const loader = new SystemPromptLoader({ client: mockClient });
            const result = await loader.loadTemplate();

            expect(result).toEqual(MINIMAL_FALLBACK_TEMPLATE);
        });
    });

    describe('needsReload', () => {
        it('returns true when no cache exists', () => {
            const mockClient = makeMockClient([]);
            const loader = new SystemPromptLoader({ client: mockClient });
            expect(loader.needsReload()).toBe(true);
        });

        it('returns false after successful load within TTL', async () => {
            const template = makeValidTemplate();
            const mockClient = makeMockClient([
                { SecretString: JSON.stringify({ systemPromptTemplate: template }) },
            ]);

            const loader = new SystemPromptLoader({ client: mockClient, ttlMs: 300_000 });
            await loader.loadTemplate();

            expect(loader.needsReload()).toBe(false);
        });

        it('returns true after TTL expires', async () => {
            const template = makeValidTemplate();
            const mockClient = makeMockClient([
                { SecretString: JSON.stringify({ systemPromptTemplate: template }) },
            ]);

            const loader = new SystemPromptLoader({ client: mockClient, ttlMs: 1 });
            await loader.loadTemplate();

            await new Promise((r) => setTimeout(r, 5));
            expect(loader.needsReload()).toBe(true);
        });
    });

    describe('getCached', () => {
        it('returns null before any load', () => {
            const mockClient = makeMockClient([]);
            const loader = new SystemPromptLoader({ client: mockClient });
            expect(loader.getCached()).toBeNull();
        });

        it('returns cached prompt after successful load', async () => {
            const template = makeValidTemplate();
            const mockClient = makeMockClient([
                { SecretString: JSON.stringify({ systemPromptTemplate: template }) },
            ]);

            const loader = new SystemPromptLoader({ client: mockClient, ttlMs: 300_000 });
            await loader.loadTemplate();

            const cached = loader.getCached();
            expect(cached).not.toBeNull();
            expect(cached!.template).toEqual(template);
            expect(cached!.ttlMs).toBe(300_000);
            expect(cached!.loadedAt).toBeGreaterThan(0);
        });
    });

    describe('clearCache', () => {
        it('clears the cached template', async () => {
            const template = makeValidTemplate();
            const mockClient = makeMockClient([
                { SecretString: JSON.stringify({ systemPromptTemplate: template }) },
            ]);

            const loader = new SystemPromptLoader({ client: mockClient });
            await loader.loadTemplate();

            expect(loader.getCached()).not.toBeNull();
            loader.clearCache();
            expect(loader.getCached()).toBeNull();
        });
    });
});
