/**
 * Unit tests for SettingsManager — verifies read/write operations,
 * fallback chain resolution, and broadcast/audit behavior.
 *
 * Uses an in-memory SQLite database to avoid filesystem side effects.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { SettingsManager } from './settings-manager.js';
import type { BroadcastFn } from './settings-manager.js';

// ── Test Helpers ──

function createTestDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    return db;
}

describe('SettingsManager', () => {
    let db: Database.Database;
    let broadcast: BroadcastFn;
    let manager: SettingsManager;

    beforeEach(() => {
        db = createTestDb();
        broadcast = vi.fn();
        manager = new SettingsManager(db, broadcast);
    });

    describe('constructor / migration', () => {
        it('creates the settings table on construction', () => {
            const row = db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'")
                .get();
            expect(row).toBeDefined();
        });

        it('creates the updated_at index', () => {
            const row = db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_settings_updated'")
                .get();
            expect(row).toBeDefined();
        });
    });

    describe('getSetting', () => {
        it('returns schema default when no DB override or env exists', () => {
            const value = manager.getSetting('cron.ingest_schedule');
            expect(value).toBe('0 2 * * *');
        });

        it('returns DB override when one exists', () => {
            db.prepare(
                "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
            ).run('cron.ingest_schedule', '0 3 * * *', '2024-01-01T00:00:00Z', 'admin');

            const value = manager.getSetting('cron.ingest_schedule');
            expect(value).toBe('0 3 * * *');
        });

        it('throws for unknown keys', () => {
            expect(() => manager.getSetting('unknown.key')).toThrow('Unknown setting');
        });
    });

    describe('getSettingFull', () => {
        it('returns full metadata with source=default when no override', () => {
            const result = manager.getSettingFull('ingestion.lookback_hours');
            expect(result).toEqual({
                key: 'ingestion.lookback_hours',
                value: '24',
                source: 'default',
                updated_at: 'boot',
                updated_by: 'system',
            });
        });

        it('returns source=database when DB override exists', () => {
            db.prepare(
                "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
            ).run('ingestion.lookback_hours', '48', '2024-06-15T10:00:00Z', 'admin');

            const result = manager.getSettingFull('ingestion.lookback_hours');
            expect(result.source).toBe('database');
            expect(result.value).toBe('48');
            expect(result.updated_by).toBe('admin');
        });
    });

    describe('getAllSettings', () => {
        it('returns all settings grouped by category', () => {
            const groups = manager.getAllSettings();
            expect(groups.length).toBeGreaterThan(0);

            // Check categories are sorted alphabetically
            const categories = groups.map((g) => g.category);
            const sorted = [...categories].sort();
            expect(categories).toEqual(sorted);
        });

        it('includes definition metadata with each setting', () => {
            const groups = manager.getAllSettings();
            const firstSetting = groups[0].settings[0];
            expect(firstSetting.definition).toBeDefined();
            expect(firstSetting.definition.key).toBe(firstSetting.key);
            expect(firstSetting.definition.label).toBeDefined();
        });

        it('reflects DB overrides in the result', () => {
            db.prepare(
                "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
            ).run('chat.archive_mode', 'all', '2024-01-01T00:00:00Z', 'admin');

            const groups = manager.getAllSettings();
            const chatGroup = groups.find((g) => g.category === 'chat');
            const archiveSetting = chatGroup?.settings.find((s) => s.key === 'chat.archive_mode');

            expect(archiveSetting?.value).toBe('all');
            expect(archiveSetting?.source).toBe('database');
        });
    });

    describe('updateSetting', () => {
        it('persists a valid value to the database', () => {
            const result = manager.updateSetting('chat.archive_mode', 'self', 'admin');

            expect(result.success).toBe(true);
            expect(result.previousValue).toBe('off'); // schema default

            // Verify persisted
            const stored = manager.getSetting('chat.archive_mode');
            expect(stored).toBe('self');
        });

        it('returns requiresRestart flag from definition', () => {
            const result = manager.updateSetting('container.idle_timeout_ms', '120000', 'admin');
            expect(result.requiresRestart).toBe(true);

            const result2 = manager.updateSetting('chat.archive_mode', 'dms', 'admin');
            expect(result2.requiresRestart).toBe(false);
        });

        it('broadcasts settings_changed event via SSE', () => {
            manager.updateSetting('ingestion.lookback_hours', '48', 'admin');

            expect(broadcast).toHaveBeenCalledWith('settings_changed', expect.objectContaining({
                key: 'ingestion.lookback_hours',
                value: '48',
                source: 'database',
            }));
        });

        it('throws on unknown key', () => {
            expect(() => manager.updateSetting('bad.key', 'value', 'admin')).toThrow(
                'Unknown setting key',
            );
        });

        it('throws on invalid value', () => {
            expect(() => manager.updateSetting('ingestion.lookback_hours', 'abc', 'admin')).toThrow(
                'Validation failed',
            );
        });

        it('throws when number is out of range', () => {
            expect(() =>
                manager.updateSetting('ingestion.lookback_hours', '999', 'admin'),
            ).toThrow('Must be <= 168');
        });

        it('supports UPSERT — updates existing value', () => {
            manager.updateSetting('chat.archive_mode', 'self', 'admin');
            const result = manager.updateSetting('chat.archive_mode', 'all', 'admin');

            expect(result.previousValue).toBe('self');
            expect(manager.getSetting('chat.archive_mode')).toBe('all');
        });
    });

    describe('resetSetting', () => {
        it('removes DB override and falls back to default', () => {
            manager.updateSetting('chat.archive_mode', 'all', 'admin');
            const result = manager.resetSetting('chat.archive_mode');

            expect(result.previousValue).toBe('all');
            expect(result.newValue).toBe('off'); // schema default
            expect(result.source).toBe('default');
        });

        it('broadcasts the reset via SSE', () => {
            manager.updateSetting('chat.archive_mode', 'all', 'admin');
            vi.mocked(broadcast).mockClear();

            manager.resetSetting('chat.archive_mode');

            expect(broadcast).toHaveBeenCalledWith('settings_changed', expect.objectContaining({
                key: 'chat.archive_mode',
                value: 'off',
                source: 'default',
            }));
        });

        it('throws for unknown keys', () => {
            expect(() => manager.resetSetting('unknown.key')).toThrow('Unknown setting key');
        });

        it('is a no-op when no override exists (still returns default)', () => {
            const result = manager.resetSetting('chat.archive_mode');
            expect(result.previousValue).toBe('off');
            expect(result.newValue).toBe('off');
            expect(result.source).toBe('default');
        });
    });
});


describe('SettingsManager — exportOverrides', () => {
    let db: Database.Database;
    let broadcast: BroadcastFn;
    let manager: SettingsManager;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        broadcast = vi.fn();
        manager = new SettingsManager(db, broadcast);
    });

    it('returns an empty object when no DB overrides exist', () => {
        const result = manager.exportOverrides();
        expect(result).toEqual({});
    });

    it('returns only DB overrides (not defaults or env values)', () => {
        // Insert some overrides directly
        db.prepare(
            "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
        ).run('cron.ingest_schedule', '0 5 * * *', '2024-01-01T00:00:00Z', 'admin');
        db.prepare(
            "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
        ).run('chat.archive_mode', 'all', '2024-01-01T00:00:00Z', 'admin');

        const result = manager.exportOverrides();

        expect(result).toEqual({
            'cron.ingest_schedule': '0 5 * * *',
            'chat.archive_mode': 'all',
        });
        // Should NOT include settings that are only at default
        expect(result['ingestion.lookback_hours']).toBeUndefined();
    });

    it('returns overrides set via updateSetting', () => {
        manager.updateSetting('ingestion.lookback_hours', '48', 'admin');
        manager.updateSetting('channels.batch_window_ms', '10000', 'admin');

        const result = manager.exportOverrides();

        expect(result['ingestion.lookback_hours']).toBe('48');
        expect(result['channels.batch_window_ms']).toBe('10000');
    });
});

describe('SettingsManager — importSettings', () => {
    let db: Database.Database;
    let broadcast: BroadcastFn;
    let manager: SettingsManager;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        broadcast = vi.fn();
        manager = new SettingsManager(db, broadcast);
    });

    it('applies valid settings that differ from current value', () => {
        const result = manager.importSettings(
            { 'chat.archive_mode': 'all', 'ingestion.lookback_hours': '48' },
            'import',
        );

        expect(result.applied).toContain('chat.archive_mode');
        expect(result.applied).toContain('ingestion.lookback_hours');
        expect(result.skipped).toHaveLength(0);
        expect(result.errors).toHaveLength(0);

        // Verify persisted
        expect(manager.getSetting('chat.archive_mode')).toBe('all');
        expect(manager.getSetting('ingestion.lookback_hours')).toBe('48');
    });

    it('skips settings whose value is unchanged', () => {
        // Set a value first
        manager.updateSetting('chat.archive_mode', 'self', 'admin');

        // Import with the same value
        const result = manager.importSettings(
            { 'chat.archive_mode': 'self' },
            'import',
        );

        expect(result.skipped).toContain('chat.archive_mode');
        expect(result.applied).toHaveLength(0);
        expect(result.errors).toHaveLength(0);
    });

    it('skips settings that match the schema default', () => {
        // 'chat.archive_mode' default is 'off'
        const result = manager.importSettings(
            { 'chat.archive_mode': 'off' },
            'import',
        );

        expect(result.skipped).toContain('chat.archive_mode');
        expect(result.applied).toHaveLength(0);
    });

    it('reports errors for unknown keys', () => {
        const result = manager.importSettings(
            { 'unknown.setting': 'value', 'also.unknown': '123' },
            'import',
        );

        expect(result.errors).toHaveLength(2);
        expect(result.errors[0]).toEqual({ key: 'unknown.setting', message: 'Unknown setting' });
        expect(result.errors[1]).toEqual({ key: 'also.unknown', message: 'Unknown setting' });
        expect(result.applied).toHaveLength(0);
        expect(result.skipped).toHaveLength(0);
    });

    it('reports errors for invalid values', () => {
        const result = manager.importSettings(
            {
                'ingestion.lookback_hours': 'not-a-number',
                'chat.archive_mode': 'invalid_mode',
            },
            'import',
        );

        expect(result.errors).toHaveLength(2);
        expect(result.errors.find((e) => e.key === 'ingestion.lookback_hours')?.message).toBe(
            'Must be a valid number',
        );
        expect(result.errors.find((e) => e.key === 'chat.archive_mode')?.message).toContain(
            'Must be one of:',
        );
        expect(result.applied).toHaveLength(0);
        expect(result.skipped).toHaveLength(0);
    });

    it('import totality: applied + skipped + errors = input size', () => {
        // Pre-set one value so it will be skipped
        manager.updateSetting('chat.archive_mode', 'dms', 'admin');

        const input = {
            'chat.archive_mode': 'dms',           // skipped (unchanged)
            'ingestion.lookback_hours': '72',     // applied (valid, changed)
            'unknown.key': 'value',               // error (unknown)
            'channels.batch_window_ms': 'abc',    // error (invalid)
            'cron.ingest_schedule': '0 6 * * *',  // applied (valid, changed)
        };

        const result = manager.importSettings(input, 'import');

        const totalCategorized = result.applied.length + result.skipped.length + result.errors.length;
        expect(totalCategorized).toBe(Object.keys(input).length);
    });

    it('handles mixed results correctly', () => {
        const input = {
            'chat.archive_mode': 'all',           // applied
            'ingestion.lookback_hours': '24',     // skipped (matches default)
            'bad.key': 'whatever',                // error (unknown)
        };

        const result = manager.importSettings(input, 'import');

        expect(result.applied).toEqual(['chat.archive_mode']);
        expect(result.skipped).toEqual(['ingestion.lookback_hours']);
        expect(result.errors).toEqual([{ key: 'bad.key', message: 'Unknown setting' }]);
    });
});
