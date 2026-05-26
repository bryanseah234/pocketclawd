/**
 * Tests for the Secrets Manager config loader.
 *
 * Verifies:
 * - Config parsing from secret payload
 * - Caching behavior
 * - Default values when fields are missing
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();

// Mock the AWS SDK before importing the module
vi.mock('@aws-sdk/client-secrets-manager', () => {
    return {
        SecretsManagerClient: class {
            send = mockSend;
        },
        GetSecretValueCommand: class {
            constructor(public input: unknown) { }
        },
    };
});

import { SecretsLoader } from './index.js';

describe('SecretsLoader', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('loadConfig', () => {
        it('parses a complete secret payload correctly', async () => {
            const secretPayload = {
                redis_host: 'redis.example.com',
                redis_port: 6380,
                redis_password: 'secret123',
                redis_tls: true,
                dynamodb_chat_messages_table: 'prod-chat-messages',
                dynamodb_webhook_tokens_table: 'prod-webhook-tokens',
                dynamodb_user_preferences_table: 'prod-user-preferences',
                dynamodb_system_errors_table: 'prod-system-errors',
                opensearch_endpoint: 'https://search.example.com',
                opensearch_index_name: 'prod-documents',
                s3_data_bucket: 'prod-nanoclaw-data',
                llm_model_id: 'anthropic.claude-3-5-sonnet',
                llm_region: 'us-east-1',
                ecr_registry_url: '123456789.dkr.ecr.ap-southeast-1.amazonaws.com',
                ecr_agent_image: 'nanoclaw/agent:latest',
            };

            mockSend.mockResolvedValueOnce({
                SecretString: JSON.stringify(secretPayload),
            });

            const loader = new SecretsLoader({ region: 'ap-southeast-1' });
            const config = await loader.loadConfig();

            expect(config.redis.host).toBe('redis.example.com');
            expect(config.redis.port).toBe(6380);
            expect(config.redis.password).toBe('secret123');
            expect(config.redis.tls).toBe(true);
            expect(config.dynamoDb.chatMessagesTable).toBe('prod-chat-messages');
            expect(config.dynamoDb.webhookTokensTable).toBe('prod-webhook-tokens');
            expect(config.dynamoDb.userPreferencesTable).toBe('prod-user-preferences');
            expect(config.dynamoDb.systemErrorsTable).toBe('prod-system-errors');
            expect(config.openSearch.endpoint).toBe('https://search.example.com');
            expect(config.openSearch.indexName).toBe('prod-documents');
            expect(config.s3.dataBucket).toBe('prod-nanoclaw-data');
            expect(config.llm?.modelId).toBe('anthropic.claude-3-5-sonnet');
            expect(config.ecr?.registryUrl).toBe('123456789.dkr.ecr.ap-southeast-1.amazonaws.com');
        });

        it('uses default values when fields are missing', async () => {
            mockSend.mockResolvedValueOnce({
                SecretString: JSON.stringify({}),
            });

            const loader = new SecretsLoader();
            const config = await loader.loadConfig();

            expect(config.redis.host).toBe('localhost');
            expect(config.redis.port).toBe(6379);
            expect(config.redis.password).toBeUndefined();
            expect(config.redis.tls).toBe(true);
            expect(config.dynamoDb.chatMessagesTable).toBe('nanoclaw-chat-messages');
            expect(config.dynamoDb.webhookTokensTable).toBe('nanoclaw-webhook-tokens');
            expect(config.dynamoDb.userPreferencesTable).toBe('nanoclaw-user-preferences');
            expect(config.dynamoDb.systemErrorsTable).toBe('nanoclaw-system-errors');
            expect(config.openSearch.indexName).toBe('documents');
        });

        it('caches config and does not re-fetch within refresh interval', async () => {
            mockSend.mockResolvedValue({
                SecretString: JSON.stringify({ redis_host: 'cached.example.com' }),
            });

            const loader = new SecretsLoader({ refreshIntervalMs: 60000 });

            const config1 = await loader.loadConfig();
            const config2 = await loader.loadConfig();

            expect(config1).toBe(config2); // Same reference — cached
            expect(mockSend).toHaveBeenCalledTimes(1); // Only one fetch
        });

        it('throws when secret has no string value', async () => {
            mockSend.mockResolvedValueOnce({
                SecretString: undefined,
            });

            const loader = new SecretsLoader();
            await expect(loader.loadConfig()).rejects.toThrow('has no string value');
        });
    });

    describe('getCachedConfig', () => {
        it('returns null before loadConfig is called', () => {
            const loader = new SecretsLoader();
            expect(loader.getCachedConfig()).toBeNull();
        });

        it('returns cached config after loadConfig', async () => {
            mockSend.mockResolvedValueOnce({
                SecretString: JSON.stringify({ redis_host: 'test.example.com' }),
            });

            const loader = new SecretsLoader();
            await loader.loadConfig();

            const cached = loader.getCachedConfig();
            expect(cached).not.toBeNull();
            expect(cached!.redis.host).toBe('test.example.com');
        });
    });

    describe('auto-refresh', () => {
        it('starts and stops without error', () => {
            const loader = new SecretsLoader({ refreshIntervalMs: 100000 });
            loader.startAutoRefresh();
            loader.stopAutoRefresh();
            // No assertion needed — just verifying no throw
        });
    });
});
