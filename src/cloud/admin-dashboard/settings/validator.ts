/**
 * Settings Validator — validates setting values against their schema definitions.
 *
 * Implements the validateValue algorithm from the design document:
 * - boolean: must be "true" or "false"
 * - number: parseFloat, check NaN, check min/max
 * - enum: value must be in definition.options
 * - cron: must match 5-field cron pattern (M H DOM MON DOW)
 * - string: if validation_pattern exists, must match regex
 *
 * Also provides cross-field validation helpers for constraints that span
 * multiple settings (e.g., chunk overlap must be less than chunk size).
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

import type { SettingDefinition, ValidationResult } from './types.js';

// ── Cron Validation ──

/**
 * Validates a 5-field cron expression (minute hour day-of-month month day-of-week).
 *
 * Each field supports:
 * - Wildcards: *
 * - Numeric values within valid ranges
 * - Ranges: 1-5
 * - Step values: *\/5, 1-30/2
 * - Lists: 1,3,5
 */
function isValidCronExpression(value: string): boolean {
    const parts = value.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    const ranges: Array<[number, number]> = [
        [0, 59],  // minute
        [0, 23],  // hour
        [1, 31],  // day of month
        [1, 12],  // month
        [0, 7],   // day of week (0 and 7 both = Sunday)
    ];

    for (let i = 0; i < 5; i++) {
        if (!isValidCronField(parts[i], ranges[i][0], ranges[i][1])) {
            return false;
        }
    }

    return true;
}

/**
 * Validates a single cron field against its allowed numeric range.
 */
function isValidCronField(field: string, min: number, max: number): boolean {
    // Handle lists (e.g., "1,3,5")
    const listParts = field.split(',');
    for (const part of listParts) {
        if (!isValidCronPart(part, min, max)) {
            return false;
        }
    }
    return true;
}

/**
 * Validates a single part of a cron field (handles *, ranges, and steps).
 */
function isValidCronPart(part: string, min: number, max: number): boolean {
    // Wildcard
    if (part === '*') return true;

    // Step value: */5 or 1-30/2
    if (part.includes('/')) {
        const [rangePart, stepStr] = part.split('/');
        const step = parseInt(stepStr, 10);
        if (isNaN(step) || step < 1) return false;
        // Validate the range part
        if (rangePart === '*') return true;
        return isValidCronRange(rangePart, min, max);
    }

    // Range: 1-5
    if (part.includes('-')) {
        return isValidCronRange(part, min, max);
    }

    // Single numeric value
    const num = parseInt(part, 10);
    return !isNaN(num) && num >= min && num <= max;
}

/**
 * Validates a cron range expression (e.g., "1-5").
 */
function isValidCronRange(range: string, min: number, max: number): boolean {
    const [startStr, endStr] = range.split('-');
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    if (isNaN(start) || isNaN(end)) return false;
    return start >= min && end <= max && start <= end;
}

// ── Main Validation ──

/**
 * Validates a setting value against its schema definition.
 *
 * Implements the design document's validateValue algorithm:
 * - CASE "boolean": value must be "true" or "false"
 * - CASE "number": parseFloat, check NaN, check min/max
 * - CASE "enum": value must be in definition.options
 * - CASE "cron": must match 5-field cron pattern
 * - CASE "string": if validation_pattern exists, must match regex
 *
 * @param definition - The setting's schema definition
 * @param value - The string value to validate
 * @returns ValidationResult with valid flag and error message
 */
export function validateValue(definition: SettingDefinition, value: string): ValidationResult {
    switch (definition.type) {
        case 'boolean':
            if (value !== 'true' && value !== 'false') {
                return { valid: false, message: "Must be 'true' or 'false'" };
            }
            break;

        case 'number': {
            const numVal = parseFloat(value);
            if (isNaN(numVal)) {
                return { valid: false, message: 'Must be a valid number' };
            }
            if (definition.min !== null && numVal < definition.min) {
                return { valid: false, message: `Must be >= ${definition.min}` };
            }
            if (definition.max !== null && numVal > definition.max) {
                return { valid: false, message: `Must be <= ${definition.max}` };
            }
            break;
        }

        case 'enum':
            if (!definition.options || !definition.options.includes(value)) {
                const optionsList = definition.options ? definition.options.join(', ') : '';
                return { valid: false, message: `Must be one of: ${optionsList}` };
            }
            break;

        case 'cron':
            if (!isValidCronExpression(value)) {
                return { valid: false, message: 'Must be a valid cron expression (M H DOM MON DOW)' };
            }
            break;

        case 'string':
            if (definition.validation_pattern !== null) {
                const regex = new RegExp(definition.validation_pattern);
                if (!regex.test(value)) {
                    return { valid: false, message: 'Does not match required pattern' };
                }
            }
            break;
    }

    return { valid: true, message: '' };
}

// ── Cross-Field Validation ──

/**
 * Cross-field validation result for constraints that span multiple settings.
 */
export interface CrossFieldError {
    /** The setting key that has the violation */
    key: string;
    /** Descriptive error message */
    message: string;
}

/**
 * Validates cross-field constraints across a set of settings.
 *
 * Currently supports:
 * - Chunk overlap must be less than chunk size (if both are present)
 *
 * @param settings - Map of setting key to value (string)
 * @returns Array of cross-field validation errors (empty if all valid)
 */
export function validateCrossField(settings: Map<string, string>): CrossFieldError[] {
    const errors: CrossFieldError[] = [];

    // Cross-field: chunk overlap must be less than chunk size
    const chunkSize = settings.get('kb.chunk_size');
    const chunkOverlap = settings.get('kb.chunk_overlap');

    if (chunkSize !== undefined && chunkOverlap !== undefined) {
        const sizeNum = parseFloat(chunkSize);
        const overlapNum = parseFloat(chunkOverlap);

        if (!isNaN(sizeNum) && !isNaN(overlapNum) && overlapNum >= sizeNum) {
            errors.push({
                key: 'kb.chunk_overlap',
                message: 'Chunk overlap must be less than chunk size',
            });
        }
    }

    return errors;
}
