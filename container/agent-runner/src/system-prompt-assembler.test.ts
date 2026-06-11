/**
 * Tests for the System Prompt Assembler.
 *
 * Verifies:
 * - All sections are concatenated in the correct order
 * - Runtime addendum is appended at the end
 * - Missing/empty sections are skipped with a warning
 * - Graceful handling of edge cases
 *
 * Requirements: 10.1, 10.3
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';

import { assembleSystemPrompt } from './system-prompt-assembler.js';
import type { SystemPromptTemplate } from './system-prompt-loader.js';

// ── Test Helpers ──

function makeFullTemplate(overrides?: Partial<SystemPromptTemplate['sections']>): SystemPromptTemplate {
    return {
        version: '1.0.0',
        sections: {
            identity: 'You are Clawd, a senior specialist AI assistant.',
            onboarding: 'Ask two discovery questions for new users.',
            responseStyle: 'Be concise. Use numbered lists.',
            guardrails: 'Never say "As an AI...".',
            confidence: 'Answer directly when confident.',
            coding: 'Use fenced code blocks.',
            escalation: 'Inform user and suggest next steps.',
            ...overrides,
        },
        updatedAt: '2024-06-01T12:00:00Z',
    };
}

// ── Tests ──

describe('assembleSystemPrompt', () => {
    let warnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        warnSpy = spyOn(console, 'warn').mockImplementation(() => { });
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    describe('section ordering', () => {
        it('concatenates all sections in the correct order', () => {
            const template = makeFullTemplate();
            const result = assembleSystemPrompt(template);

            const identityIdx = result.indexOf(template.sections.identity);
            const onboardingIdx = result.indexOf(template.sections.onboarding);
            const responseStyleIdx = result.indexOf(template.sections.responseStyle);
            const guardrailsIdx = result.indexOf(template.sections.guardrails);
            const confidenceIdx = result.indexOf(template.sections.confidence);
            const codingIdx = result.indexOf(template.sections.coding);
            const escalationIdx = result.indexOf(template.sections.escalation);

            expect(identityIdx).toBeLessThan(onboardingIdx);
            expect(onboardingIdx).toBeLessThan(responseStyleIdx);
            expect(responseStyleIdx).toBeLessThan(guardrailsIdx);
            expect(guardrailsIdx).toBeLessThan(confidenceIdx);
            expect(confidenceIdx).toBeLessThan(codingIdx);
            expect(codingIdx).toBeLessThan(escalationIdx);
        });

        it('includes all section content in the output', () => {
            const template = makeFullTemplate();
            const result = assembleSystemPrompt(template);

            expect(result).toContain(template.sections.identity);
            expect(result).toContain(template.sections.onboarding);
            expect(result).toContain(template.sections.responseStyle);
            expect(result).toContain(template.sections.guardrails);
            expect(result).toContain(template.sections.confidence);
            expect(result).toContain(template.sections.coding);
            expect(result).toContain(template.sections.escalation);
        });

        it('separates sections with double newlines', () => {
            const template = makeFullTemplate();
            const result = assembleSystemPrompt(template);

            // Each section should be separated by \n\n
            const expected = [
                template.sections.identity,
                template.sections.onboarding,
                template.sections.responseStyle,
                template.sections.guardrails,
                template.sections.confidence,
                template.sections.coding,
                template.sections.escalation,
            ].join('\n\n');

            expect(result).toBe(expected);
        });
    });

    describe('runtime addendum', () => {
        it('appends runtime addendum after all sections', () => {
            const template = makeFullTemplate();
            const addendum = '# You are Clawd\n\n## Sending messages\nYour destination is `casa`.';

            const result = assembleSystemPrompt(template, addendum);

            expect(result).toContain(addendum);
            // Addendum should come after escalation (last section)
            const escalationIdx = result.indexOf(template.sections.escalation);
            const addendumIdx = result.indexOf(addendum);
            expect(addendumIdx).toBeGreaterThan(escalationIdx);
        });

        it('does not append addendum when undefined', () => {
            const template = makeFullTemplate();
            const result = assembleSystemPrompt(template, undefined);

            // Should end with the escalation section
            expect(result).toEndWith(template.sections.escalation);
        });

        it('does not append addendum when empty string', () => {
            const template = makeFullTemplate();
            const result = assembleSystemPrompt(template, '');

            expect(result).toEndWith(template.sections.escalation);
        });

        it('does not append addendum when whitespace-only', () => {
            const template = makeFullTemplate();
            const result = assembleSystemPrompt(template, '   \n  \t  ');

            expect(result).toEndWith(template.sections.escalation);
        });
    });

    describe('missing/empty section handling', () => {
        it('skips a section that is empty string and logs a warning', () => {
            const template = makeFullTemplate({ onboarding: '' });
            const result = assembleSystemPrompt(template);

            expect(result).not.toContain('Ask two discovery questions');
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('"onboarding" is missing or empty'),
            );
        });

        it('skips a section that is whitespace-only and logs a warning', () => {
            const template = makeFullTemplate({ guardrails: '   \n  ' });
            const result = assembleSystemPrompt(template);

            expect(result).not.toContain('Never say');
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('"guardrails" is missing or empty'),
            );
        });

        it('skips multiple missing sections without error', () => {
            const template = makeFullTemplate({
                onboarding: '',
                guardrails: '',
                escalation: '',
            });
            const result = assembleSystemPrompt(template);

            expect(result).toContain(template.sections.identity);
            expect(result).toContain(template.sections.responseStyle);
            expect(result).toContain(template.sections.confidence);
            expect(result).toContain(template.sections.coding);
            expect(warnSpy).toHaveBeenCalledTimes(3);
        });

        it('maintains correct ordering when sections are skipped', () => {
            const template = makeFullTemplate({
                onboarding: '',
                confidence: '',
            });
            const result = assembleSystemPrompt(template);

            const identityIdx = result.indexOf(template.sections.identity);
            const responseStyleIdx = result.indexOf(template.sections.responseStyle);
            const guardrailsIdx = result.indexOf(template.sections.guardrails);
            const codingIdx = result.indexOf(template.sections.coding);
            const escalationIdx = result.indexOf(template.sections.escalation);

            expect(identityIdx).toBeLessThan(responseStyleIdx);
            expect(responseStyleIdx).toBeLessThan(guardrailsIdx);
            expect(guardrailsIdx).toBeLessThan(codingIdx);
            expect(codingIdx).toBeLessThan(escalationIdx);
        });

        it('returns empty string when all sections are empty and no addendum', () => {
            const template: SystemPromptTemplate = {
                version: '1.0.0',
                sections: {
                    identity: '',
                    onboarding: '',
                    responseStyle: '',
                    guardrails: '',
                    confidence: '',
                    coding: '',
                    escalation: '',
                },
                updatedAt: '2024-06-01T12:00:00Z',
            };
            const result = assembleSystemPrompt(template);

            expect(result).toBe('');
            expect(warnSpy).toHaveBeenCalledTimes(7);
        });

        it('returns only addendum when all sections are empty', () => {
            const template: SystemPromptTemplate = {
                version: '1.0.0',
                sections: {
                    identity: '',
                    onboarding: '',
                    responseStyle: '',
                    guardrails: '',
                    confidence: '',
                    coding: '',
                    escalation: '',
                },
                updatedAt: '2024-06-01T12:00:00Z',
            };
            const addendum = '# Runtime context';
            const result = assembleSystemPrompt(template, addendum);

            expect(result).toBe(addendum);
        });
    });
});
