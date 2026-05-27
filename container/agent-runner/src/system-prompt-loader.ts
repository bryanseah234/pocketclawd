/**
 * System Prompt Template Loader — loads, caches, and hot-reloads the
 * structured system prompt from AWS Secrets Manager.
 *
 * The template is stored as JSON in either:
 *   - `nanoclaw/app-config` secret → `systemPromptTemplate` key
 *   - Standalone `nanoclaw/system-prompt` secret
 *
 * Caching: in-memory with a configurable TTL (default 5 minutes).
 * On session initialization, `shouldReload` is checked; if stale, a fresh
 * fetch is attempted. On failure, the last cached template is used. If no
 * cache exists at all, a hardcoded minimal prompt is returned.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4
 */

import {
    SecretsManagerClient,
    GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

// ── Types ──

export interface SystemPromptTemplate {
    version: string;
    sections: {
        identity: string;
        onboarding: string;
        responseStyle: string;
        guardrails: string;
        confidence: string;
        coding: string;
        escalation: string;
    };
    updatedAt: string;
}

export interface CachedPrompt {
    template: SystemPromptTemplate;
    loadedAt: number;    // Unix timestamp (ms)
    ttlMs: number;       // Default: 300_000 (5 minutes)
}

export interface SystemPromptLoaderConfig {
    region?: string;
    appConfigSecretId?: string;
    standaloneSecretId?: string;
    ttlMs?: number;
    /** Inject a custom Secrets Manager client (useful for testing). */
    client?: SecretsManagerClient;
}

// ── Constants ──

const DEFAULT_REGION = 'ap-southeast-1';
const DEFAULT_APP_CONFIG_SECRET_ID = 'nanoclaw/app-config';
const DEFAULT_STANDALONE_SECRET_ID = 'nanoclaw/system-prompt';
const DEFAULT_TTL_MS = 300_000; // 5 minutes

/**
 * Hardcoded minimal prompt used as last-resort fallback when no cache
 * exists and Secrets Manager is unreachable.
 */
export const MINIMAL_FALLBACK_TEMPLATE: SystemPromptTemplate = {
    version: '0.0.0',
    sections: {
        identity: 'You are Clawd, a helpful AI assistant.',
        onboarding: 'If this is a new user, greet them warmly and ask about their preferences.',
        responseStyle: 'Be concise and helpful. Use numbered lists for choices.',
        guardrails: 'Do not use phrases like "As an AI..." or "Please wait while I process...".',
        confidence: 'Answer directly when confident. Add caveats when uncertain. Escalate when unsure.',
        coding: 'Use fenced code blocks with language identifiers. State assumed versions.',
        escalation: 'If you cannot help, inform the user and suggest next steps.',
    },
    updatedAt: '1970-01-01T00:00:00Z',
};

// ── Helpers ──

export function shouldReload(cached: CachedPrompt): boolean {
    return Date.now() - cached.loadedAt > cached.ttlMs;
}

// ── Loader ──

export class SystemPromptLoader {
    private readonly client: SecretsManagerClient;
    private readonly appConfigSecretId: string;
    private readonly standaloneSecretId: string;
    private readonly ttlMs: number;

    private cached: CachedPrompt | null = null;

    constructor(config?: SystemPromptLoaderConfig) {
        const region = config?.region ?? DEFAULT_REGION;
        this.appConfigSecretId = config?.appConfigSecretId ?? DEFAULT_APP_CONFIG_SECRET_ID;
        this.standaloneSecretId = config?.standaloneSecretId ?? DEFAULT_STANDALONE_SECRET_ID;
        this.ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;

        this.client = config?.client ?? new SecretsManagerClient({ region });
    }

    /**
     * Load the system prompt template. Returns cached version if still fresh.
     * On session initialization, call this to get the current template.
     *
     * Fallback chain:
     *   1. Return cached template if TTL not expired
     *   2. Fetch from Secrets Manager (app-config → standalone)
     *   3. Return last cached template if fetch fails
     *   4. Return hardcoded minimal template if no cache exists
     */
    async loadTemplate(): Promise<SystemPromptTemplate> {
        // Fast path: cache is fresh
        if (this.cached && !shouldReload(this.cached)) {
            return this.cached.template;
        }

        // Attempt to fetch from Secrets Manager
        try {
            const template = await this.fetchFromSecretsManager();
            this.cached = {
                template,
                loadedAt: Date.now(),
                ttlMs: this.ttlMs,
            };
            return template;
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[system-prompt-loader] Failed to load template: ${errMsg}`);

            // Fallback: use last cached template if available
            if (this.cached) {
                console.error('[system-prompt-loader] Using stale cached template as fallback');
                return this.cached.template;
            }

            // Last resort: hardcoded minimal prompt
            console.error('[system-prompt-loader] No cache available, using minimal fallback template');
            return MINIMAL_FALLBACK_TEMPLATE;
        }
    }

    /**
     * Check if the cached template is stale and should be reloaded.
     * Returns true if no cache exists or TTL has expired.
     */
    needsReload(): boolean {
        if (!this.cached) return true;
        return shouldReload(this.cached);
    }

    /**
     * Get the currently cached prompt without fetching.
     * Returns null if no template has been loaded yet.
     */
    getCached(): CachedPrompt | null {
        return this.cached;
    }

    /**
     * Force-clear the cache (useful for testing).
     */
    clearCache(): void {
        this.cached = null;
    }

    // ── Private ──

    /**
     * Fetch the template from Secrets Manager. Tries the app-config secret
     * first (looking for a `systemPromptTemplate` key), then falls back to
     * the standalone secret.
     */
    private async fetchFromSecretsManager(): Promise<SystemPromptTemplate> {
        // Strategy 1: Try app-config secret with systemPromptTemplate key
        try {
            const appConfig = await this.fetchSecret(this.appConfigSecretId);
            const parsed = JSON.parse(appConfig) as Record<string, unknown>;

            if (parsed.systemPromptTemplate) {
                const template = typeof parsed.systemPromptTemplate === 'string'
                    ? JSON.parse(parsed.systemPromptTemplate) as unknown
                    : parsed.systemPromptTemplate;
                return this.validateTemplate(template);
            }
        } catch {
            // Fall through to standalone secret
        }

        // Strategy 2: Try standalone secret
        const standalone = await this.fetchSecret(this.standaloneSecretId);
        const parsed = JSON.parse(standalone) as unknown;
        return this.validateTemplate(parsed);
    }

    private async fetchSecret(secretId: string): Promise<string> {
        const response = await this.client.send(
            new GetSecretValueCommand({ SecretId: secretId }),
        );

        if (!response.SecretString) {
            throw new Error(`Secret ${secretId} has no string value`);
        }

        return response.SecretString;
    }

    private validateTemplate(raw: unknown): SystemPromptTemplate {
        if (!raw || typeof raw !== 'object') {
            throw new Error('Template is not an object');
        }

        const obj = raw as Record<string, unknown>;

        if (typeof obj.version !== 'string') {
            throw new Error('Template missing or invalid "version" field');
        }

        if (!obj.sections || typeof obj.sections !== 'object') {
            throw new Error('Template missing or invalid "sections" field');
        }

        const sections = obj.sections as Record<string, unknown>;
        const requiredSections = [
            'identity', 'onboarding', 'responseStyle',
            'guardrails', 'confidence', 'coding', 'escalation',
        ] as const;

        for (const key of requiredSections) {
            if (typeof sections[key] !== 'string') {
                throw new Error(`Template section "${key}" is missing or not a string`);
            }
        }

        if (typeof obj.updatedAt !== 'string') {
            throw new Error('Template missing or invalid "updatedAt" field');
        }

        return {
            version: obj.version,
            sections: {
                identity: sections.identity as string,
                onboarding: sections.onboarding as string,
                responseStyle: sections.responseStyle as string,
                guardrails: sections.guardrails as string,
                confidence: sections.confidence as string,
                coding: sections.coding as string,
                escalation: sections.escalation as string,
            },
            updatedAt: obj.updatedAt,
        };
    }
}
