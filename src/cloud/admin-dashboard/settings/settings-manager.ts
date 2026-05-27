/**
 * SettingsManager — central singleton for reading, writing, validating,
 * and broadcasting settings changes.
 *
 * Implements the design document algorithms:
 * - resolveSettingValue(key): DB → env → default fallback chain
 * - updateSetting(key, value, actor): validate → persist → broadcast → audit
 * - resetSetting(key): delete override → fallback to env/default
 * - getAllSettings(): merge DB overrides with schema defaults, group by category
 *
 * The settings table is created on first access (CREATE TABLE IF NOT EXISTS).
 * This avoids coupling to the central migration runner — the settings module
 * is self-contained and can be loaded independently.
 *
 * Requirements: 1.2, 3.1, 3.2, 3.3, 3.4, 5.1, 5.2
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type Database from 'better-sqlite3';

import { readEnvFile } from '../../../env.js';
import { getDb } from '../../../db/connection.js';
import { envPath } from '../../../modules/paths.js';

import type {
    SettingValue,
    SettingCategory,
    SettingActor,
    SettingDefinition,
    UpdateResult,
    ValidationResult,
    ImportResult,
} from './types.js';
import { SETTINGS_REGISTRY, getDefinition } from './schema.js';
import { validateValue } from './validator.js';

// ── Types ──

/** A group of settings under a single category, returned by getAllSettings(). */
export interface CategoryGroup {
    category: SettingCategory;
    settings: Array<SettingValue & { definition: SettingDefinition }>;
}

/** Callback signature for SSE broadcast. */
export type BroadcastFn = (event: string, data: unknown) => void;

// ── Audit Logging ──

const LOG_PATH = envPath('LOG_PATH', 'logs');
const AUDIT_LOG = path.join(LOG_PATH, 'audit.log');

async function audit(line: string): Promise<void> {
    try {
        await fs.mkdir(path.dirname(AUDIT_LOG), { recursive: true });
        await fs.appendFile(AUDIT_LOG, `${new Date().toISOString()} | ${line}\n`, 'utf8');
    } catch {
        // best effort — audit log loss is acceptable
    }
}

// ── SettingsManager Class ──

export class SettingsManager {
    private db: Database.Database;
    private broadcast: BroadcastFn;
    private migrated = false;

    constructor(db: Database.Database, broadcast?: BroadcastFn) {
        this.db = db;
        this.broadcast = broadcast ?? (() => { });
        this.ensureMigrated();
    }

    // ── Migration ──

    /**
     * Creates the settings table if it doesn't exist.
     * Safe to call multiple times (idempotent).
     */
    private ensureMigrated(): void {
        if (this.migrated) return;
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                updated_by TEXT NOT NULL DEFAULT 'system'
            );
            CREATE INDEX IF NOT EXISTS idx_settings_updated ON settings(updated_at);
        `);
        this.migrated = true;
    }

    // ── Read Operations ──

    /**
     * Retrieve all settings grouped by category.
     * Each setting includes its resolved value, source, and full definition.
     *
     * Postconditions:
     * - Returns all registered settings grouped by category
     * - Categories are sorted alphabetically
     * - Settings within categories are sorted by key
     */
    getAllSettings(): CategoryGroup[] {
        // Fetch all DB overrides in one query
        const rows = this.db
            .prepare('SELECT key, value, updated_at, updated_by FROM settings')
            .all() as Array<{ key: string; value: string; updated_at: string; updated_by: string }>;

        const dbOverrides = new Map(rows.map((r) => [r.key, r]));

        // Collect all env_fallback keys we might need
        const envKeys = SETTINGS_REGISTRY
            .filter((def) => def.env_fallback !== null)
            .map((def) => def.env_fallback as string);

        const envValues = envKeys.length > 0 ? readEnvFile(envKeys) : {};

        // Build grouped result
        const categoryMap = new Map<SettingCategory, Array<SettingValue & { definition: SettingDefinition }>>();

        for (const def of SETTINGS_REGISTRY) {
            const resolved = this.resolveWithContext(def, dbOverrides, envValues);
            const entry = { ...resolved, definition: def };

            const list = categoryMap.get(def.category) ?? [];
            list.push(entry);
            categoryMap.set(def.category, list);
        }

        // Sort categories alphabetically, settings by key within each category
        const categories = [...categoryMap.keys()].sort();
        return categories.map((cat) => ({
            category: cat,
            settings: categoryMap.get(cat)!.sort((a, b) => a.key.localeCompare(b.key)),
        }));
    }

    /**
     * Resolve a single setting value with the fallback chain: DB → env → default.
     *
     * Preconditions:
     * - key is registered in SCHEMA_REGISTRY
     *
     * Postconditions:
     * - Returns the resolved value as a string
     * - Never returns null — always falls through to default
     * - Throws if key is unknown
     */
    getSetting(key: string): string {
        const resolved = this.resolveSettingValue(key);
        return resolved.value;
    }

    /**
     * Resolve a single setting with full metadata (value, source, timestamps).
     *
     * Throws if the key is not registered in the schema.
     */
    getSettingFull(key: string): SettingValue {
        return this.resolveSettingValue(key);
    }

    // ── Write Operations ──

    /**
     * Validate and persist a setting value.
     *
     * Preconditions:
     * - key is registered in SCHEMA_REGISTRY
     * - newValue is a non-null string
     * - actor is one of "admin", "system", "import"
     *
     * Postconditions:
     * - Setting is persisted in the database (UPSERT)
     * - SSE broadcast sent to all connected clients
     * - Audit log entry written
     * - Returns success with restart indicator
     */
    updateSetting(key: string, newValue: string, actor: SettingActor): UpdateResult {
        // Step 1: Validate key exists in schema
        const definition = getDefinition(key);
        if (!definition) {
            throw new Error(`Unknown setting key: ${key}`);
        }

        // Step 2: Validate value against type constraints
        const validationResult: ValidationResult = validateValue(definition, newValue);
        if (!validationResult.valid) {
            throw new Error(`Validation failed for "${key}": ${validationResult.message}`);
        }

        // Step 3: Read previous value for audit
        const previousValue = this.resolveSettingValue(key);

        // Step 4: Persist to database (UPSERT)
        const now = new Date().toISOString();
        this.db
            .prepare(
                `INSERT INTO settings (key, value, updated_at, updated_by)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?, updated_by = ?`,
            )
            .run(key, newValue, now, actor, newValue, now, actor);

        // Step 5: Broadcast change to SSE clients
        this.broadcast('settings_changed', {
            key,
            value: newValue,
            source: 'database',
            updated_at: now,
            requires_restart: definition.requires_restart,
        });

        // Step 6: Audit log (fire-and-forget)
        void audit(
            `SETTINGS_CHANGED | key=${key} prev=${previousValue.value} new=${newValue} by=${actor}`,
        );

        return {
            success: true,
            requiresRestart: definition.requires_restart,
            previousValue: previousValue.value,
        };
    }

    /**
     * Remove a database override for a setting, falling back to env or default.
     *
     * Preconditions:
     * - key is registered in SCHEMA_REGISTRY
     *
     * Postconditions:
     * - Database override for key is deleted
     * - Value falls back to env or default
     * - SSE broadcast sent
     * - Audit log entry written
     */
    resetSetting(key: string): { previousValue: string; newValue: string; source: string } {
        const definition = getDefinition(key);
        if (!definition) {
            throw new Error(`Unknown setting key: ${key}`);
        }

        // Read current value before reset
        const previousValue = this.resolveSettingValue(key);

        // Delete the DB override
        this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);

        // Resolve the new value (will fall back to env or default)
        const newResolved = this.resolveSettingValue(key);

        // Broadcast the reset
        this.broadcast('settings_changed', {
            key,
            value: newResolved.value,
            source: newResolved.source,
            updated_at: newResolved.updated_at,
            requires_restart: definition.requires_restart,
        });

        // Audit log (fire-and-forget)
        void audit(
            `SETTINGS_RESET | key=${key} prev=${previousValue.value} new=${newResolved.value} source=${newResolved.source}`,
        );

        return {
            previousValue: previousValue.value,
            newValue: newResolved.value,
            source: newResolved.source,
        };
    }

    // ── Export / Import ──

    /**
     * Export all non-default settings (DB overrides) as a key→value map.
     *
     * Only includes settings that have been explicitly persisted to the database.
     * Does not include env fallbacks or schema defaults.
     *
     * Postconditions:
     * - Returns a Record<string, string> of all DB-persisted overrides
     * - Keys not in the DB are not included
     */
    exportOverrides(): Record<string, string> {
        const rows = this.db
            .prepare('SELECT key, value FROM settings')
            .all() as Array<{ key: string; value: string }>;

        const result: Record<string, string> = {};
        for (const row of rows) {
            result[row.key] = row.value;
        }
        return result;
    }

    /**
     * Bulk-import settings from a key→value map.
     *
     * For each entry:
     * - Unknown keys → errors with "Unknown setting"
     * - Invalid values → errors with validation message
     * - Unchanged values → skipped
     * - Valid changed values → applied via updateSetting()
     *
     * Postconditions:
     * - Every entry is categorized into exactly one of applied, skipped, or errors
     * - length(applied) + length(skipped) + length(errors) = length(settingsJson)
     * - All applied settings are persisted and broadcast
     * - Audit log entry summarizing the import is written
     */
    importSettings(settingsJson: Record<string, string>, actor: SettingActor): ImportResult {
        const applied: string[] = [];
        const skipped: string[] = [];
        const errors: Array<{ key: string; message: string }> = [];

        for (const [key, value] of Object.entries(settingsJson)) {
            // Check if key is registered
            const definition = getDefinition(key);
            if (!definition) {
                errors.push({ key, message: 'Unknown setting' });
                continue;
            }

            // Validate value
            const validationResult: ValidationResult = validateValue(definition, value);
            if (!validationResult.valid) {
                errors.push({ key, message: validationResult.message });
                continue;
            }

            // Check if value is unchanged
            const currentValue = this.getSetting(key);
            if (currentValue === value) {
                skipped.push(key);
                continue;
            }

            // Apply the setting
            this.updateSetting(key, value, actor);
            applied.push(key);
        }

        // Audit log summarizing the import
        void audit(
            `SETTINGS_IMPORT | applied=${applied.length} skipped=${skipped.length} errors=${errors.length}`,
        );

        return { applied, skipped, errors };
    }

    // ── Internal Resolution ──

    /**
     * Core resolution algorithm: DB → env → default.
     * Implements Property 2 (Fallback Chain Completeness) — never returns null.
     */
    private resolveSettingValue(key: string): SettingValue {
        const definition = getDefinition(key);
        if (!definition) {
            throw new Error(`Unknown setting: ${key}`);
        }

        // Step 1: Check database override (highest priority)
        const row = this.db
            .prepare('SELECT value, updated_at, updated_by FROM settings WHERE key = ?')
            .get(key) as { value: string; updated_at: string; updated_by: string } | undefined;

        if (row) {
            return {
                key,
                value: row.value,
                source: 'database',
                updated_at: row.updated_at,
                updated_by: row.updated_by,
            };
        }

        // Step 2: Check .env fallback (if defined)
        if (definition.env_fallback) {
            const envValues = readEnvFile([definition.env_fallback]);
            const envValue = envValues[definition.env_fallback];
            if (envValue) {
                return {
                    key,
                    value: envValue,
                    source: 'env',
                    updated_at: 'boot',
                    updated_by: 'system',
                };
            }
        }

        // Step 3: Return schema default (lowest priority)
        return {
            key,
            value: definition.default_value,
            source: 'default',
            updated_at: 'boot',
            updated_by: 'system',
        };
    }

    /**
     * Resolve a setting using pre-fetched DB overrides and env values.
     * Used by getAllSettings() to avoid N+1 queries.
     */
    private resolveWithContext(
        definition: SettingDefinition,
        dbOverrides: Map<string, { value: string; updated_at: string; updated_by: string }>,
        envValues: Record<string, string>,
    ): SettingValue {
        // Check DB override
        const row = dbOverrides.get(definition.key);
        if (row) {
            return {
                key: definition.key,
                value: row.value,
                source: 'database',
                updated_at: row.updated_at,
                updated_by: row.updated_by,
            };
        }

        // Check env fallback
        if (definition.env_fallback) {
            const envValue = envValues[definition.env_fallback];
            if (envValue) {
                return {
                    key: definition.key,
                    value: envValue,
                    source: 'env',
                    updated_at: 'boot',
                    updated_by: 'system',
                };
            }
        }

        // Schema default
        return {
            key: definition.key,
            value: definition.default_value,
            source: 'default',
            updated_at: 'boot',
            updated_by: 'system',
        };
    }

    // ── Broadcast Setter ──

    /**
     * Update the broadcast function. Used when wiring up the SSE infrastructure
     * after construction.
     */
    setBroadcast(fn: BroadcastFn): void {
        this.broadcast = fn;
    }
}

// ── Factory ──

/**
 * Create a SettingsManager instance using the central database.
 * Optionally accepts a broadcast function for SSE notifications.
 *
 * Usage:
 *   const manager = createSettingsManager();
 *   // Later, wire up SSE:
 *   manager.setBroadcast(broadcastSse);
 */
export function createSettingsManager(broadcast?: BroadcastFn): SettingsManager {
    const db = getDb();
    return new SettingsManager(db, broadcast);
}
