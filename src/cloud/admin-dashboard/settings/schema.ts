/**
 * Settings Schema Registry — canonical list of all configurable parameters.
 *
 * This registry is populated at module load time and never modified at runtime
 * (Property 7: Schema Immutability). It defines validation rules, defaults,
 * and metadata for every setting exposed through the admin dashboard.
 *
 * Requirements: 1.3, 1.4
 */

import type { SettingDefinition } from './types.js';

// ── Registry Definition ──

/**
 * The canonical settings registry. Each entry defines a configurable parameter
 * with its type, constraints, default value, and UI metadata.
 *
 * Settings are organized by category:
 * - scheduling: Cron expressions for automated jobs
 * - ingestion: Source toggles and lookback configuration
 * - chat: Chat archive mode
 * - notifications: Digest delivery preferences
 * - channels: Channel adapter toggles and batching
 * - container: Container lifecycle parameters
 * - knowledge_base: Knowledge base GC thresholds
 */
export const SETTINGS_REGISTRY: ReadonlyArray<SettingDefinition> = [
    // ── Scheduling ──
    {
        key: 'cron.ingest_schedule',
        category: 'scheduling',
        label: 'Ingestion Schedule',
        description: 'Cron expression for the data ingestion job',
        type: 'cron',
        default_value: '0 2 * * *',
        env_fallback: 'CRON_INGEST_SCHEDULE',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'cron.wiki_schedule',
        category: 'scheduling',
        label: 'Wiki Sync Schedule',
        description: 'Cron expression for the wiki synchronization job',
        type: 'cron',
        default_value: '0 3 * * *',
        env_fallback: 'CRON_WIKI_SCHEDULE',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'cron.gc_schedule',
        category: 'scheduling',
        label: 'Garbage Collection Schedule',
        description: 'Cron expression for the knowledge base garbage collection job',
        type: 'cron',
        default_value: '0 4 * * *',
        env_fallback: 'CRON_GC_SCHEDULE',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'cron.digest_schedule',
        category: 'scheduling',
        label: 'Digest Schedule',
        description: 'Cron expression for the daily digest notification job',
        type: 'cron',
        default_value: '0 7 * * *',
        env_fallback: 'CRON_DIGEST_SCHEDULE',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },

    // ── Ingestion ──
    {
        key: 'ingestion.google_enabled',
        category: 'ingestion',
        label: 'Google Ingestion',
        description: 'Enable ingestion from Google services (Gmail, Calendar, Drive)',
        type: 'boolean',
        default_value: 'true',
        env_fallback: 'INGESTION_GOOGLE_ENABLED',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'ingestion.apple_enabled',
        category: 'ingestion',
        label: 'Apple Ingestion',
        description: 'Enable ingestion from Apple services (iCloud)',
        type: 'boolean',
        default_value: 'true',
        env_fallback: 'INGESTION_APPLE_ENABLED',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'ingestion.github_enabled',
        category: 'ingestion',
        label: 'GitHub Ingestion',
        description: 'Enable ingestion from GitHub repositories and notifications',
        type: 'boolean',
        default_value: 'true',
        env_fallback: 'INGESTION_GITHUB_ENABLED',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'ingestion.slack_enabled',
        category: 'ingestion',
        label: 'Slack Ingestion',
        description: 'Enable ingestion from Slack workspaces',
        type: 'boolean',
        default_value: 'false',
        env_fallback: 'INGESTION_SLACK_ENABLED',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'ingestion.lookback_hours',
        category: 'ingestion',
        label: 'Lookback Hours',
        description: 'Number of hours to look back when ingesting new data',
        type: 'number',
        default_value: '24',
        env_fallback: 'INGESTION_LOOKBACK_HOURS',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: 1,
        max: 168,
    },


    // ── Credentials ──
    // Stored encrypted via Secrets Manager in production.
    // In dev/local mode, these override env vars read by the ingestion adapters.
    {
        key: 'credentials.google_client_id',
        category: 'credentials',
        label: 'Google Client ID',
        description: 'OAuth 2.0 Client ID for Google services (Gmail, Calendar, Drive). Get from Google Cloud Console → APIs & Services → Credentials.',
        type: 'string',
        default_value: '',
        env_fallback: 'GOOGLE_CLIENT_ID',
        options: null,
        requires_restart: true,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'credentials.google_client_secret',
        category: 'credentials',
        label: 'Google Client Secret',
        description: 'OAuth 2.0 Client Secret for Google services. Keep this secret — never share it.',
        type: 'secret',
        default_value: '',
        env_fallback: 'GOOGLE_CLIENT_SECRET',
        options: null,
        requires_restart: true,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'credentials.google_refresh_token',
        category: 'credentials',
        label: 'Google Refresh Token',
        description: 'OAuth 2.0 Refresh Token for Google services. Obtained after completing the OAuth flow. Run: pnpm exec tsx scripts/google-auth.ts to generate.',
        type: 'secret',
        default_value: '',
        env_fallback: 'GOOGLE_REFRESH_TOKEN',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'credentials.github_token',
        category: 'credentials',
        label: 'GitHub Personal Access Token',
        description: 'GitHub PAT with repo, notifications, read:user scopes. Generate at github.com/settings/tokens.',
        type: 'secret',
        default_value: '',
        env_fallback: 'GITHUB_TOKEN',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'credentials.slack_bot_token',
        category: 'credentials',
        label: 'Slack Bot Token',
        description: 'Slack Bot OAuth token (xoxb-...). Create a Slack app at api.slack.com/apps, add channels:history and channels:read scopes, install to workspace.',
        type: 'secret',
        default_value: '',
        env_fallback: 'SLACK_BOT_TOKEN',
        options: null,
        requires_restart: false,
        validation_pattern: '^xoxb-',
        min: null,
        max: null,
    },
    {
        key: 'credentials.apple_icloud_username',
        category: 'credentials',
        label: 'iCloud Apple ID (email)',
        description: 'Your Apple ID email address for iCloud ingestion.',
        type: 'string',
        default_value: '',
        env_fallback: 'APPLE_ICLOUD_USERNAME',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'credentials.apple_icloud_app_password',
        category: 'credentials',
        label: 'iCloud App-Specific Password',
        description: 'App-specific password for iCloud (NOT your Apple ID password). Generate at appleid.apple.com → Sign-In and Security → App-Specific Passwords.',
        type: 'secret',
        default_value: '',
        env_fallback: 'APPLE_ICLOUD_APP_PASSWORD',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'credentials.whatsapp_phone_number',
        category: 'credentials',
        label: 'WhatsApp Phone Number',
        description: 'Phone number in international format (e.g. +6012345678) for WhatsApp pairing code auth. Leave blank to use QR scan instead.',
        type: 'string',
        default_value: '',
        env_fallback: 'WHATSAPP_PHONE_NUMBER',
        options: null,
        requires_restart: true,
        validation_pattern: '^\\+[1-9][0-9]{7,14}$',
        min: null,
        max: null,
    },

    // ── Chat ──
    {
        key: 'chat.archive_mode',
        category: 'chat',
        label: 'Chat Archive Mode',
        description: 'Which conversations to archive: off, self-only, DMs, or all',
        type: 'enum',
        default_value: 'off',
        env_fallback: 'CHAT_ARCHIVE_MODE',
        options: ['off', 'self', 'dms', 'all'],
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },

    // ── Notifications ──
    {
        key: 'notifications.digest_enabled',
        category: 'notifications',
        label: 'Daily Digest',
        description: 'Enable the daily digest notification',
        type: 'boolean',
        default_value: 'true',
        env_fallback: 'NOTIFICATIONS_DIGEST_ENABLED',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'notifications.digest_timezone',
        category: 'notifications',
        label: 'Digest Timezone',
        description: 'IANA timezone for digest delivery (e.g. Asia/Singapore)',
        type: 'string',
        default_value: 'Asia/Singapore',
        env_fallback: 'NOTIFICATIONS_DIGEST_TIMEZONE',
        options: null,
        requires_restart: false,
        validation_pattern: '^[A-Za-z]+/[A-Za-z_]+$',
        min: null,
        max: null,
    },

    // ── Channels ──
    {
        key: 'channels.whatsapp_enabled',
        category: 'channels',
        label: 'WhatsApp Channel',
        description: 'Enable the WhatsApp messaging channel',
        type: 'boolean',
        default_value: 'true',
        env_fallback: 'CHANNELS_WHATSAPP_ENABLED',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'channels.telegram_enabled',
        category: 'channels',
        label: 'Telegram Channel',
        description: 'Enable the Telegram messaging channel',
        type: 'boolean',
        default_value: 'true',
        env_fallback: 'CHANNELS_TELEGRAM_ENABLED',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
    },
    {
        key: 'channels.batch_window_ms',
        category: 'channels',
        label: 'Batch Window (ms)',
        description: 'Milliseconds to wait before batching incoming messages',
        type: 'number',
        default_value: '5000',
        env_fallback: 'CHANNELS_BATCH_WINDOW_MS',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: 1000,
        max: 30000,
    },

    // ── Container ──
    {
        key: 'container.idle_timeout_ms',
        category: 'container',
        label: 'Idle Timeout (ms)',
        description: 'Milliseconds before an idle container is stopped',
        type: 'number',
        default_value: '1800000',
        env_fallback: 'CONTAINER_IDLE_TIMEOUT_MS',
        options: null,
        requires_restart: true,
        validation_pattern: null,
        min: 60000,
        max: 7200000,
    },
    {
        key: 'container.max_concurrent',
        category: 'container',
        label: 'Max Concurrent Containers',
        description: 'Maximum number of containers running simultaneously',
        type: 'number',
        default_value: '5',
        env_fallback: 'CONTAINER_MAX_CONCURRENT',
        options: null,
        requires_restart: true,
        validation_pattern: null,
        min: 1,
        max: 20,
    },

    // ── Knowledge Base ──
    {
        key: 'kb.gc_importance_threshold',
        category: 'knowledge_base',
        label: 'GC Importance Threshold',
        description: 'Minimum importance score to retain during garbage collection (0.0–1.0)',
        type: 'number',
        default_value: '0.5',
        env_fallback: 'KB_GC_IMPORTANCE_THRESHOLD',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: 0.0,
        max: 1.0,
    },
    {
        key: 'kb.gc_candidate_limit',
        category: 'knowledge_base',
        label: 'GC Candidate Limit',
        description: 'Maximum number of candidates to evaluate per GC run',
        type: 'number',
        default_value: '50',
        env_fallback: 'KB_GC_CANDIDATE_LIMIT',
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: 10,
        max: 500,
    },
] as const;

// ── Lookup Helpers ──

/** Map for O(1) lookup by key. Built once at module load. */
const registryMap = new Map<string, SettingDefinition>(
    SETTINGS_REGISTRY.map((def) => [def.key, def]),
);

/**
 * Look up a setting definition by its dot-notation key.
 * Returns undefined if the key is not registered.
 */
export function getDefinition(key: string): SettingDefinition | undefined {
    return registryMap.get(key);
}

/**
 * Get all setting definitions for a given category.
 */
export function getDefinitionsByCategory(category: string): SettingDefinition[] {
    return SETTINGS_REGISTRY.filter((def) => def.category === category);
}

/**
 * Get all unique category names from the registry.
 */
export function getCategories(): string[] {
    return [...new Set(SETTINGS_REGISTRY.map((def) => def.category))];
}

/**
 * Check whether a key is registered in the schema.
 */
export function isRegisteredKey(key: string): boolean {
    return registryMap.has(key);
}
