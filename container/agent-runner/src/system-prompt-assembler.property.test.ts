/**
 * Property-Based Test: System Prompt Template Assembly Preserves All Sections
 *
 * Property 5: For any valid SystemPromptTemplate with all sections populated
 * (non-empty strings), the assembled output string contains content from every
 * section with no section omitted or empty.
 *
 * **Validates: Requirements 10.1, 10.3**
 */
import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';

import { assembleSystemPrompt } from './system-prompt-assembler.js';
import type { SystemPromptTemplate } from './system-prompt-loader.js';

/**
 * Arbitrary that generates non-empty, non-whitespace-only strings.
 * These represent valid section content that should always appear in output.
 */
const nonEmptySectionArb = fc.string({ minLength: 1 }).filter(s => s.trim().length > 0);

/**
 * Arbitrary that generates a valid SystemPromptTemplate with all sections populated.
 */
const fullTemplateArb: fc.Arbitrary<SystemPromptTemplate> = fc.record({
    version: fc.string({ minLength: 1 }),
    sections: fc.record({
        identity: nonEmptySectionArb,
        onboarding: nonEmptySectionArb,
        responseStyle: nonEmptySectionArb,
        guardrails: nonEmptySectionArb,
        confidence: nonEmptySectionArb,
        coding: nonEmptySectionArb,
        escalation: nonEmptySectionArb,
    }),
    updatedAt: fc.string({ minLength: 1 }),
});

describe('Feature: clawd-bot-persona, Property 5: System prompt template assembly preserves all sections', () => {
    it('assembled output contains content from every populated section', () => {
        fc.assert(
            fc.property(fullTemplateArb, (template) => {
                const result = assembleSystemPrompt(template);

                // Every section's content must appear in the assembled output
                expect(result).toContain(template.sections.identity);
                expect(result).toContain(template.sections.onboarding);
                expect(result).toContain(template.sections.responseStyle);
                expect(result).toContain(template.sections.guardrails);
                expect(result).toContain(template.sections.confidence);
                expect(result).toContain(template.sections.coding);
                expect(result).toContain(template.sections.escalation);
            }),
            { numRuns: 100 },
        );
    });

    it('assembled output contains runtime addendum when provided', () => {
        const runtimeAddendumArb = nonEmptySectionArb;

        fc.assert(
            fc.property(fullTemplateArb, runtimeAddendumArb, (template, addendum) => {
                const result = assembleSystemPrompt(template, addendum);

                // All sections must still be present
                expect(result).toContain(template.sections.identity);
                expect(result).toContain(template.sections.onboarding);
                expect(result).toContain(template.sections.responseStyle);
                expect(result).toContain(template.sections.guardrails);
                expect(result).toContain(template.sections.confidence);
                expect(result).toContain(template.sections.coding);
                expect(result).toContain(template.sections.escalation);

                // Runtime addendum must also be present
                expect(result).toContain(addendum);
            }),
            { numRuns: 100 },
        );
    });
});
