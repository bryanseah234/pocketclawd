/**
 * Secrets Manager Config Loader — loads and caches secrets from AWS Secrets Manager.
 *
 * In cloud mode, replaces .env file reads with runtime secret injection via IAM roles.
 * Caches secrets in memory with a configurable refresh interval (default 5 minutes).
 *
 * Requirements: REQ-1.3
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

import { log } from '../../log.js';

// ── Types ──

export interface NanoClawCloudConfig {
    // Redis
    redis: {
        host: string;
        port: number;
        password?: string;
        tls: boolean;
    };
    // DynamoDB table names
    dynamoDb: {
        chatMessagesTable: string;
        webhookTokensTable: string;
        userPreferencesTable: string;
        systemErrorsTable: string;
    };
    // OpenSearch
    openSearch: {
        endpoint: string;
        indexName: string;
    };
    // S3
    s3: {
        dataBucket: string;
    };
    // LLM
    llm?: {
        modelId?: string;
        region?: string;
    };
    // ECR
    ecr?: {
        registryUrl?: string;
        agentImage?: string;
    };
}

export interface SecretsLoaderConfig {
    region?: string;
    secretId?: string;
    refreshIntervalMs?: number;
}

// ── Default values ──

const DEFAULT_REGION = 'ap-southeast-1';
const DEFAULT_SECRET_ID = 'nanoclaw/app-config';
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Secrets Loader ──

export class SecretsLoader {
    private readonly client: SecretsManagerClient;
    private readonly secretId: string;
    private readonly refreshIntervalMs: number;

    private cachedConfig: NanoClawCloudConfig | null = null;
    private lastFetchedAt: number = 0;
    private refreshTimer: ReturnType<typeof setInterval> | null = null;

    constructor(config?: SecretsLoaderConfig) {
        const region = config?.region ?? DEFAULT_REGION;
        this.secretId = config?.secretId ?? DEFAULT_SECRET_ID;
        this.refreshIntervalMs = config?.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;

        this.client = new SecretsManagerClient({ region });
    }

    /**
     * Load configuration from Secrets Manager. Fetches on first call,
     * returns cached value on subsequent calls until refresh interval expires.
     */
    async loadConfig(): Promise<NanoClawCloudConfig> {
        if (this.cachedConfig && Date.now() - this.lastFetchedAt < this.refreshIntervalMs) {
            return this.cachedConfig;
        }

        return this.fetchAndCache();
    }

    /**
     * Force a fresh fetch from Secrets Manager, bypassing the cache.
     */
    async refresh(): Promise<NanoClawCloudConfig> {
        return this.fetchAndCache();
    }

    /**
     * Start background refresh timer. Periodically refreshes the cached config
     * so that rotated secrets are picked up without restart.
     */
    startAutoRefresh(): void {
        if (this.refreshTimer) return;

        this.refreshTimer = setInterval(() => {
            void this.fetchAndCache().catch((err) => {
                log.error('Secrets auto-refresh failed', { err });
            });
        }, this.refreshIntervalMs);
    }

    /**
     * Stop background refresh timer.
     */
    stopAutoRefresh(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    /**
     * Get the currently cached config without fetching.
     * Returns null if loadConfig() hasn't been called yet.
     */
    getCachedConfig(): NanoClawCloudConfig | null {
        return this.cachedConfig;
    }

    // ── Private ──

    private async fetchAndCache(): Promise<NanoClawCloudConfig> {
        const response = await this.client.send(
            new GetSecretValueCommand({ SecretId: this.secretId }),
        );

        if (!response.SecretString) {
            throw new Error(`Secret ${this.secretId} has no string value`);
        }

        const raw = JSON.parse(response.SecretString) as Record<string, unknown>;
        const config = this.parseSecretPayload(raw);

        this.cachedConfig = config;
        this.lastFetchedAt = Date.now();

        log.info('Secrets loaded from Secrets Manager', { secretId: this.secretId });

        return config;
    }

    private parseSecretPayload(raw: Record<string, unknown>): NanoClawCloudConfig {
        return {
            redis: {
                host: (raw.redis_host as string) ?? 'localhost',
                port: (raw.redis_port as number) ?? 6379,
                password: raw.redis_password as string | undefined,
                tls: (raw.redis_tls as boolean) ?? true,
            },
            dynamoDb: {
                chatMessagesTable: (raw.dynamodb_chat_messages_table as string) ?? 'nanoclaw-chat-messages',
                webhookTokensTable: (raw.dynamodb_webhook_tokens_table as string) ?? 'nanoclaw-webhook-tokens',
                userPreferencesTable: (raw.dynamodb_user_preferences_table as string) ?? 'nanoclaw-user-preferences',
                systemErrorsTable: (raw.dynamodb_system_errors_table as string) ?? 'nanoclaw-system-errors',
            },
            openSearch: {
                endpoint: (raw.opensearch_endpoint as string) ?? '',
                indexName: (raw.opensearch_index_name as string) ?? 'documents',
            },
            s3: {
                dataBucket: (raw.s3_data_bucket as string) ?? '',
            },
            llm: {
                modelId: raw.llm_model_id as string | undefined,
                region: raw.llm_region as string | undefined,
            },
            ecr: {
                registryUrl: raw.ecr_registry_url as string | undefined,
                agentImage: raw.ecr_agent_image as string | undefined,
            },
        };
    }
}
