/**
 * Property-based tests for the settings validator module.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
 *
 * Property 3: Validation Soundness — if validateValue(def, v) returns valid=true,
 * then v is safe to persist and parseable by consumers; if valid=false, persisting
 * would violate constraints.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateValue } from './validator.js';
import type { SettingDefinition } from './types.js';

// ── Helper to create minimal definitions ──

function makeDef(overrides: Partial<SettingDefinition>): SettingDefinition {
    return {
        key: 'test.key',
        category: 'scheduling',
        label: 'Test',
        description: 'Test setting',
        type: 'string',
        default_value: '',
        env_fallback: null,
        options: null,
        requires_restart: false,
        validation_pattern: null,
        min: null,
        max: null,
        ...overrides,
    };
}

// ── Property Tests ──

describe('Property 3: Validation Soundness', () => {
    describe('type=boolean: valid=true implies value is parseable as boolean', () => {
        it('if validateValue returns valid=true, the value is exactly "true" or "false"', () => {
            const def = makeDef({ type: 'boolean' });

            fc.assert(
                fc.property(fc.string(), (value) => {
                    const result = validateValue(def, value);
                    if (result.valid) {
                        expect(value === 'true' || value === 'false').toBe(true);
                    }
                }),
            );
        });
    });

    describe('type=number: valid=true implies value is a parseable number within bounds', () => {
        it('if validateValue returns valid=true, parseFloat(value) is not NaN and is within [min, max]', () => {
            const min = 1;
            const max = 168;
            const def = makeDef({ type: 'number', min, max });

            fc.assert(
                fc.property(fc.string(), (value) => {
                    const result = validateValue(def, value);
                    if (result.valid) {
                        const numVal = parseFloat(value);
                        expect(Number.isNaN(numVal)).toBe(false);
                        expect(numVal).toBeGreaterThanOrEqual(min);
                        expect(numVal).toBeLessThanOrEqual(max);
                    }
                }),
            );
        });
    });

    describe('type=enum: valid=true implies value is in definition.options', () => {
        it('if validateValue returns valid=true, the value is in the options list', () => {
            const options = ['off', 'self', 'dms', 'all'];
            const def = makeDef({ type: 'enum', options });

            fc.assert(
                fc.property(fc.string(), (value) => {
                    const result = validateValue(def, value);
                    if (result.valid) {
                        expect(options).toContain(value);
                    }
                }),
            );
        });
    });

    describe('type=cron: valid=true implies value has exactly 5 space-separated fields', () => {
        it('if validateValue returns valid=true, the value has exactly 5 space-separated fields', () => {
            const def = makeDef({ type: 'cron' });

            fc.assert(
                fc.property(fc.string(), (value) => {
                    const result = validateValue(def, value);
                    if (result.valid) {
                        const fields = value.trim().split(/\s+/);
                        expect(fields.length).toBe(5);
                    }
                }),
            );
        });
    });

    describe('type=string with pattern: valid=true implies value matches the regex', () => {
        it('if validateValue returns valid=true, the value matches the regex pattern', () => {
            const pattern = '^[A-Za-z]+/[A-Za-z_]+$';
            const def = makeDef({ type: 'string', validation_pattern: pattern });

            fc.assert(
                fc.property(fc.string(), (value) => {
                    const result = validateValue(def, value);
                    if (result.valid) {
                        const regex = new RegExp(pattern);
                        expect(regex.test(value)).toBe(true);
                    }
                }),
            );
        });
    });

    describe('type=number inverse: value outside [min, max] implies valid=false', () => {
        it('for type=number, if a value is outside [min, max], validateValue returns valid=false', () => {
            const min = 1;
            const max = 168;
            const def = makeDef({ type: 'number', min, max });

            // Generate numbers that are strictly outside the valid range
            const outsideRange = fc.oneof(
                // Below min
                fc.integer({ min: -10000, max: 0 }),
                // Above max
                fc.integer({ min: 169, max: 10000 }),
            );

            fc.assert(
                fc.property(outsideRange, (num) => {
                    const value = num.toString();
                    const result = validateValue(def, value);
                    expect(result.valid).toBe(false);
                }),
            );
        });
    });
});
