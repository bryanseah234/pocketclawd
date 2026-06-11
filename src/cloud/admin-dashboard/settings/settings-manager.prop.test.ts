/**
 * Property-based test: Resolution Determinism
 *
 * **Validates: Requirements 1.2**
 *
 * Property 1: For any registered setting key `k`, calling `getSetting(k)` or
 * `getSettingFull(k)` multiple times without intervening writes always returns
 * the same value. This demonstrates that reads are deterministic when no
 * mutations occur.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fc from 'fast-check';

// ── Mocks ──

vi.mock('../../../env.js', () => ({
    readEnvFile: () => ({}),
}));

vi.mock('../../../db/connection.js', () => ({
    getDb: () => null,
}));

vi.mock('../../../modules/paths.js', () => ({
    envPath: () => 'logs',
}));

import { SettingsManager } from './settings-manager.js';
import { SETTINGS_REGISTRY } from './schema.js';

// ── Test Setup ──

const registeredKeys = SETTINGS_REGISTRY.map((def) => def.key);

describe('Property 1: Resolution Determinism', { timeout: 60_000 }, () => {
    let db: InstanceType<typeof Database>;
    let manager: SettingsManager;

    beforeEach(() => {
        db = new Database(':memory:');
        manager = new SettingsManager(db);
    });

    it('getSetting(k) returns the same value on repeated calls without writes', () => {
        fc.assert(
            fc.property(fc.constantFrom(...registeredKeys), (key) => {
                const results: string[] = [];
                for (let i = 0; i < 5; i++) {
                    results.push(manager.getSetting(key));
                }
                // All 5 calls must return the same value
                const allEqual = results.every((v) => v === results[0]);
                expect(allEqual).toBe(true);
            }),
            { numRuns: 100 },
        );
    });

    it('getSettingFull(k) returns identical objects on repeated calls without writes', () => {
        fc.assert(
            fc.property(fc.constantFrom(...registeredKeys), (key) => {
                const results = [];
                for (let i = 0; i < 5; i++) {
                    results.push(manager.getSettingFull(key));
                }
                // All 5 calls must return deeply equal objects
                for (let i = 1; i < results.length; i++) {
                    expect(results[i]).toEqual(results[0]);
                }
            }),
            { numRuns: 100 },
        );
    });

    it('getSetting(k) remains deterministic after a write (reads are consistent between writes)', () => {
        fc.assert(
            fc.property(fc.constantFrom(...registeredKeys), (key) => {
                // Write a value first to put it in the DB
                const def = SETTINGS_REGISTRY.find((d) => d.key === key)!;
                manager.updateSetting(key, def.default_value, 'admin');

                // Now read multiple times without further writes
                const results: string[] = [];
                for (let i = 0; i < 5; i++) {
                    results.push(manager.getSetting(key));
                }
                const allEqual = results.every((v) => v === results[0]);
                expect(allEqual).toBe(true);
            }),
            { numRuns: 100 },
        );
    });
});

// ── Arbitrary: valid key-value pairs ──

/**
 * Generates a valid [key, value] pair for any registered setting,
 * respecting type constraints from the schema.
 */
const arbitraryKeyValuePair: fc.Arbitrary<[string, string]> = fc
    .constantFrom(...SETTINGS_REGISTRY)
    .chain((def) => {
        let valueArb: fc.Arbitrary<string>;
        switch (def.type) {
            case 'boolean':
                valueArb = fc.constantFrom('true', 'false');
                break;
            case 'number':
                valueArb = fc
                    .integer({ min: Math.ceil(def.min ?? 0), max: Math.floor(def.max ?? 1000) })
                    .map(String);
                break;
            case 'enum':
                valueArb = fc.constantFrom(...(def.options ?? [def.default_value]));
                break;
            case 'cron':
                valueArb = fc.constantFrom('0 2 * * *', '30 4 * * *', '*/5 * * * *');
                break;
            case 'string':
            default:
                valueArb = fc.constant(def.default_value);
                break;
        }
        return valueArb.map((v) => [def.key, v] as [string, string]);
    });

/**
 * Property-based test: Idempotent Writes
 *
 * **Validates: Requirements 3.1**
 *
 * Property 4: Calling `updateSetting(k, v, actor)` twice with the same arguments
 * produces the same stored state (UPSERT semantics). The second call does not
 * create a duplicate row or change the value.
 */
describe('Property 4: Idempotent Writes', { timeout: 60_000 }, () => {
    let db: InstanceType<typeof Database>;
    let manager: SettingsManager;

    beforeEach(() => {
        db = new Database(':memory:');
        manager = new SettingsManager(db);
    });

    it('updateSetting(k, v, actor) twice produces the same stored state', () => {
        fc.assert(
            fc.property(arbitraryKeyValuePair, ([key, value]) => {
                // First write
                manager.updateSetting(key, value, 'admin');
                const stateAfterFirst = manager.getSetting(key);

                // Second write with identical arguments
                manager.updateSetting(key, value, 'admin');
                const stateAfterSecond = manager.getSetting(key);

                // Value must be the same after both calls
                expect(stateAfterSecond).toBe(stateAfterFirst);
            }),
            { numRuns: 200 },
        );
    });

    it('no duplicate rows are created by repeated writes (UPSERT semantics)', () => {
        fc.assert(
            fc.property(arbitraryKeyValuePair, ([key, value]) => {
                // Write the same key/value twice
                manager.updateSetting(key, value, 'admin');
                manager.updateSetting(key, value, 'admin');

                // Query the DB directly to verify only one row exists for this key
                const rows = db
                    .prepare('SELECT COUNT(*) as cnt FROM settings WHERE key = ?')
                    .get(key) as { cnt: number };

                expect(rows.cnt).toBe(1);
            }),
            { numRuns: 200 },
        );
    });

    it('getSettingFull(k) returns identical value and source after idempotent writes', () => {
        fc.assert(
            fc.property(arbitraryKeyValuePair, ([key, value]) => {
                manager.updateSetting(key, value, 'admin');
                const fullAfterFirst = manager.getSettingFull(key);

                manager.updateSetting(key, value, 'admin');
                const fullAfterSecond = manager.getSettingFull(key);

                // Value and source must be identical
                expect(fullAfterSecond.value).toBe(fullAfterFirst.value);
                expect(fullAfterSecond.source).toBe('database');
                expect(fullAfterFirst.source).toBe('database');
            }),
            { numRuns: 200 },
        );
    });
});


/**
 * Property-based test: Broadcast Consistency
 *
 * **Validates: Requirements 3.4**
 *
 * Property 6: After a successful `updateSetting`, all connected SSE clients
 * receive a `settings_changed` event with the new value. The broadcast function
 * is always called with the correct event name and payload containing the
 * updated key and value.
 */
describe('Property 6: Broadcast Consistency', { timeout: 60_000 }, () => {
    it('after a successful updateSetting, the broadcast function is called with settings_changed event', () => {
        fc.assert(
            fc.property(arbitraryKeyValuePair, ([key, value]) => {
                const broadcastCalls: Array<[string, unknown]> = [];
                const broadcastFn = (event: string, data: unknown) => {
                    broadcastCalls.push([event, data]);
                };

                const testDb = new Database(':memory:');
                const testManager = new SettingsManager(testDb, broadcastFn);

                testManager.updateSetting(key, value, 'admin');

                // At least one broadcast call with 'settings_changed' event
                const settingsEvents = broadcastCalls.filter(([e]) => e === 'settings_changed');
                expect(settingsEvents.length).toBeGreaterThanOrEqual(1);

                // The last settings_changed event should contain the new value
                const lastEvent = settingsEvents[settingsEvents.length - 1];
                expect((lastEvent[1] as any).key).toBe(key);
                expect((lastEvent[1] as any).value).toBe(value);
            }),
            { numRuns: 100 },
        );
    });
});

/**
 * Property-based test: Import Totality
 *
 * **Validates: Requirements 3.1**
 *
 * Property 5: For any import map of size N, the sum
 * `applied.length + skipped.length + errors.length` always equals N.
 * Every entry is accounted for in exactly one result category.
 */
describe('Property 5: Import Totality', { timeout: 60_000 }, () => {
    let db: InstanceType<typeof Database>;
    let manager: SettingsManager;

    beforeEach(() => {
        db = new Database(':memory:');
        manager = new SettingsManager(db);
    });

    /** Arbitrary that generates an import map mixing registered and unknown keys with valid and invalid values. */
    const arbitraryImportMap = fc.dictionary(
        // Keys: mix of registered keys and random unknown keys
        fc.oneof(
            fc.constantFrom(...registeredKeys),
            fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !registeredKeys.includes(s)),
        ),
        // Values: mix of plausible valid values and random strings
        fc.oneof(
            fc.constantFrom('true', 'false', '0', '1', '42', '100', 'off', 'self', 'dms', 'all', '0 2 * * *', 'Asia/Singapore'),
            fc.string({ minLength: 0, maxLength: 50 }),
        ),
        { minKeys: 0, maxKeys: 30 },
    );

    it('applied + skipped + errors = input size for any import map', () => {
        fc.assert(
            fc.property(arbitraryImportMap, (importMap) => {
                const result = manager.importSettings(importMap, 'import');
                expect(result.applied.length + result.skipped.length + result.errors.length)
                    .toBe(Object.keys(importMap).length);
            }),
            { numRuns: 200 },
        );
    });
});
