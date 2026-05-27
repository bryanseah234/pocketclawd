/**
 * Type definitions for the Admin Dashboard Settings module.
 *
 * Defines the core interfaces for setting definitions (schema),
 * resolved values, validation results, and bulk operation results.
 *
 * Requirements: 1.3, 1.4
 */

// ── Setting Type Enum ──

/** The data type of a setting value. */
export type SettingType = 'string' | 'number' | 'boolean' | 'enum' | 'cron' | 'secret';

/** The source from which a setting value was resolved. */
export type SettingSource = 'database' | 'env' | 'default';

/** The actor who last modified a setting. */
export type SettingActor = 'admin' | 'system' | 'import';

// ── Setting Categories ──

/** Logical grouping for settings in the UI. */
export type SettingCategory =
    | 'scheduling'
    | 'ingestion'
    | 'chat'
    | 'notifications'
    | 'channels'
    | 'container'
    | 'knowledge_base'
    | 'credentials' | 'setup';

// ── Core Interfaces ──

/**
 * Schema definition for a single configurable setting.
 * Populated at module load time in the settings registry.
 */
export interface SettingDefinition {
    /** Dot-notation key, e.g. "cron.ingest_schedule" */
    key: string;
    /** Logical category for UI grouping */
    category: SettingCategory;
    /** Human-readable label for the UI */
    label: string;
    /** Tooltip/help text describing the setting */
    description: string;
    /** Data type for validation and input rendering */
    type: SettingType;
    /** Serialized default value (always stored as string) */
    default_value: string;
    /** .env key to read if no DB override exists (nullable) */
    env_fallback: string | null;
    /** For type=enum, the list of valid choices */
    options: string[] | null;
    /** Whether changing this setting requires a service restart */
    requires_restart: boolean;
    /** Regex pattern for string validation (nullable) */
    validation_pattern: string | null;
    /** Minimum value for type=number (nullable) */
    min: number | null;
    /** Maximum value for type=number (nullable) */
    max: number | null;
}

/**
 * A resolved setting value with provenance metadata.
 * Returned by the SettingsManager when reading settings.
 */
export interface SettingValue {
    /** The setting key */
    key: string;
    /** The resolved value (always stored as string, parsed by consumers) */
    value: string;
    /** Where the value was resolved from: database → env → default */
    source: SettingSource;
    /** ISO 8601 timestamp of last update (or "boot" for env/default) */
    updated_at: string;
    /** Who last modified this setting */
    updated_by: string;
}

/**
 * Result of validating a setting value against its definition.
 */
export interface ValidationResult {
    /** Whether the value passed all constraints */
    valid: boolean;
    /** Descriptive error message if validation failed (empty string if valid) */
    message: string;
}

/**
 * Result of updating a single setting.
 */
export interface UpdateResult {
    /** Whether the update was persisted successfully */
    success: boolean;
    /** Whether the setting requires a service restart to take effect */
    requiresRestart: boolean;
    /** The previous value before the update */
    previousValue: string;
}

/**
 * Result of a bulk import operation.
 * Every entry in the import map is categorized into exactly one list.
 */
export interface ImportResult {
    /** Keys that were successfully applied (value changed) */
    applied: string[];
    /** Keys that were skipped (value unchanged) */
    skipped: string[];
    /** Keys that failed validation or are unknown */
    errors: Array<{ key: string; message: string }>;
}
