/**
 * Unit tests for the settings validator module.
 *
 * Tests validateValue for each type (boolean, number, enum, cron, string)
 * and cross-field validation.
 */

import { describe, it, expect } from 'vitest';
import { validateValue, validateCrossField } from './validator.js';
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

// ── Boolean Validation ──

describe('validateValue — boolean', () => {
    const def = makeDef({ type: 'boolean' });

    it('accepts "true"', () => {
        expect(validateValue(def, 'true')).toEqual({ valid: true, message: '' });
    });

    it('accepts "false"', () => {
        expect(validateValue(def, 'false')).toEqual({ valid: true, message: '' });
    });

    it('rejects "yes"', () => {
        const result = validateValue(def, 'yes');
        expect(result.valid).toBe(false);
        expect(result.message).toContain("'true' or 'false'");
    });

    it('rejects "1"', () => {
        expect(validateValue(def, '1').valid).toBe(false);
    });

    it('rejects empty string', () => {
        expect(validateValue(def, '').valid).toBe(false);
    });
});

// ── Number Validation ──

describe('validateValue — number', () => {
    const def = makeDef({ type: 'number', min: 1, max: 168 });

    it('accepts a valid integer within range', () => {
        expect(validateValue(def, '24')).toEqual({ valid: true, message: '' });
    });

    it('accepts the minimum value', () => {
        expect(validateValue(def, '1')).toEqual({ valid: true, message: '' });
    });

    it('accepts the maximum value', () => {
        expect(validateValue(def, '168')).toEqual({ valid: true, message: '' });
    });

    it('accepts a float within range', () => {
        expect(validateValue(def, '12.5')).toEqual({ valid: true, message: '' });
    });

    it('rejects non-numeric string', () => {
        const result = validateValue(def, 'abc');
        expect(result.valid).toBe(false);
        expect(result.message).toContain('valid number');
    });

    it('rejects value below minimum', () => {
        const result = validateValue(def, '0');
        expect(result.valid).toBe(false);
        expect(result.message).toContain('>= 1');
    });

    it('rejects value above maximum', () => {
        const result = validateValue(def, '200');
        expect(result.valid).toBe(false);
        expect(result.message).toContain('<= 168');
    });

    it('rejects empty string', () => {
        expect(validateValue(def, '').valid).toBe(false);
    });

    it('accepts number with no min/max constraints', () => {
        const noBounds = makeDef({ type: 'number', min: null, max: null });
        expect(validateValue(noBounds, '99999')).toEqual({ valid: true, message: '' });
    });

    it('validates float range (0.0 to 1.0)', () => {
        const floatDef = makeDef({ type: 'number', min: 0.0, max: 1.0 });
        expect(validateValue(floatDef, '0.5')).toEqual({ valid: true, message: '' });
        expect(validateValue(floatDef, '0')).toEqual({ valid: true, message: '' });
        expect(validateValue(floatDef, '1')).toEqual({ valid: true, message: '' });
        expect(validateValue(floatDef, '1.1').valid).toBe(false);
        expect(validateValue(floatDef, '-0.1').valid).toBe(false);
    });
});

// ── Enum Validation ──

describe('validateValue — enum', () => {
    const def = makeDef({ type: 'enum', options: ['off', 'self', 'dms', 'all'] });

    it('accepts a valid option', () => {
        expect(validateValue(def, 'off')).toEqual({ valid: true, message: '' });
        expect(validateValue(def, 'self')).toEqual({ valid: true, message: '' });
        expect(validateValue(def, 'dms')).toEqual({ valid: true, message: '' });
        expect(validateValue(def, 'all')).toEqual({ valid: true, message: '' });
    });

    it('rejects an invalid option', () => {
        const result = validateValue(def, 'invalid');
        expect(result.valid).toBe(false);
        expect(result.message).toContain('Must be one of');
    });

    it('rejects empty string', () => {
        expect(validateValue(def, '').valid).toBe(false);
    });

    it('is case-sensitive', () => {
        expect(validateValue(def, 'Off').valid).toBe(false);
        expect(validateValue(def, 'ALL').valid).toBe(false);
    });
});

// ── Cron Validation ──

describe('validateValue — cron', () => {
    const def = makeDef({ type: 'cron' });

    it('accepts standard cron expressions', () => {
        expect(validateValue(def, '0 2 * * *')).toEqual({ valid: true, message: '' });
        expect(validateValue(def, '30 4 1 * *')).toEqual({ valid: true, message: '' });
        expect(validateValue(def, '*/5 * * * *')).toEqual({ valid: true, message: '' });
        expect(validateValue(def, '0 0 * * 0')).toEqual({ valid: true, message: '' });
    });

    it('accepts ranges', () => {
        expect(validateValue(def, '0 9-17 * * 1-5')).toEqual({ valid: true, message: '' });
    });

    it('accepts lists', () => {
        expect(validateValue(def, '0 8,12,18 * * *')).toEqual({ valid: true, message: '' });
    });

    it('accepts step values', () => {
        expect(validateValue(def, '*/15 * * * *')).toEqual({ valid: true, message: '' });
        expect(validateValue(def, '0 */2 * * *')).toEqual({ valid: true, message: '' });
    });

    it('rejects too few fields', () => {
        const result = validateValue(def, '0 2 * *');
        expect(result.valid).toBe(false);
        expect(result.message).toContain('cron expression');
    });

    it('rejects too many fields', () => {
        expect(validateValue(def, '0 2 * * * *').valid).toBe(false);
    });

    it('rejects out-of-range minute', () => {
        expect(validateValue(def, '60 2 * * *').valid).toBe(false);
    });

    it('rejects out-of-range hour', () => {
        expect(validateValue(def, '0 24 * * *').valid).toBe(false);
    });

    it('rejects non-numeric values', () => {
        expect(validateValue(def, 'a b c d e').valid).toBe(false);
    });

    it('rejects empty string', () => {
        expect(validateValue(def, '').valid).toBe(false);
    });
});

// ── String Validation ──

describe('validateValue — string', () => {
    it('accepts any string when no pattern is set', () => {
        const def = makeDef({ type: 'string', validation_pattern: null });
        expect(validateValue(def, 'anything')).toEqual({ valid: true, message: '' });
        expect(validateValue(def, '')).toEqual({ valid: true, message: '' });
    });

    it('validates against regex pattern (timezone)', () => {
        const def = makeDef({ type: 'string', validation_pattern: '^[A-Za-z]+/[A-Za-z_]+$' });
        expect(validateValue(def, 'Asia/Singapore')).toEqual({ valid: true, message: '' });
        expect(validateValue(def, 'America/New_York')).toEqual({ valid: true, message: '' });
    });

    it('rejects values not matching pattern', () => {
        const def = makeDef({ type: 'string', validation_pattern: '^[A-Za-z]+/[A-Za-z_]+$' });
        const result = validateValue(def, 'invalid-timezone');
        expect(result.valid).toBe(false);
        expect(result.message).toContain('pattern');
    });

    it('validates Docker memory format pattern', () => {
        const def = makeDef({ type: 'string', validation_pattern: '^\\d+[mgMG]$' });
        expect(validateValue(def, '256m')).toEqual({ valid: true, message: '' });
        expect(validateValue(def, '512m')).toEqual({ valid: true, message: '' });
        expect(validateValue(def, '1g')).toEqual({ valid: true, message: '' });
        expect(validateValue(def, '2G')).toEqual({ valid: true, message: '' });
        expect(validateValue(def, 'invalid').valid).toBe(false);
        expect(validateValue(def, '512').valid).toBe(false);
    });
});

// ── Cross-Field Validation ──

describe('validateCrossField', () => {
    it('returns no errors when chunk overlap < chunk size', () => {
        const settings = new Map([
            ['kb.chunk_size', '512'],
            ['kb.chunk_overlap', '50'],
        ]);
        expect(validateCrossField(settings)).toEqual([]);
    });

    it('returns error when chunk overlap >= chunk size', () => {
        const settings = new Map([
            ['kb.chunk_size', '512'],
            ['kb.chunk_overlap', '512'],
        ]);
        const errors = validateCrossField(settings);
        expect(errors).toHaveLength(1);
        expect(errors[0].key).toBe('kb.chunk_overlap');
        expect(errors[0].message).toContain('less than chunk size');
    });

    it('returns error when chunk overlap > chunk size', () => {
        const settings = new Map([
            ['kb.chunk_size', '256'],
            ['kb.chunk_overlap', '300'],
        ]);
        const errors = validateCrossField(settings);
        expect(errors).toHaveLength(1);
    });

    it('returns no errors when only one of the pair is present', () => {
        const settings = new Map([['kb.chunk_size', '512']]);
        expect(validateCrossField(settings)).toEqual([]);
    });

    it('returns no errors for unrelated settings', () => {
        const settings = new Map([
            ['cron.ingest_schedule', '0 2 * * *'],
            ['ingestion.lookback_hours', '24'],
        ]);
        expect(validateCrossField(settings)).toEqual([]);
    });
});
