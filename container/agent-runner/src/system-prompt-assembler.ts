/**
 * System Prompt Assembler — concatenates template sections with the
 * runtime addendum (from `buildSystemPromptAddendum`) into the final
 * system prompt string sent to Bedrock Claude.
 *
 * Section ordering:
 *   identity → onboarding → responseStyle → guardrails → confidence →
 *   coding → escalation → runtime addendum
 *
 * Missing or empty sections are skipped with a warning log.
 *
 * Requirements: 10.1, 10.3
 */

import type { SystemPromptTemplate } from './system-prompt-loader.js';

/**
 * Ordered list of section keys matching the required assembly order.
 */
const SECTION_ORDER = [
    'identity',
    'onboarding',
    'responseStyle',
    'guardrails',
    'confidence',
    'coding',
    'escalation',
] as const;

/**
 * Assemble the final system prompt from a template and optional runtime addendum.
 *
 * @param template - The loaded SystemPromptTemplate with all sections
 * @param runtimeAddendum - Optional runtime context string from `buildSystemPromptAddendum`
 * @returns The fully assembled system prompt string
 */
export function assembleSystemPrompt(
    template: SystemPromptTemplate,
    runtimeAddendum?: string,
): string {
    const parts: string[] = [];

    for (const key of SECTION_ORDER) {
        const content = template.sections[key];

        if (!content || content.trim() === '') {
            console.warn(
                `[system-prompt-assembler] Section "${key}" is missing or empty — skipping`,
            );
            continue;
        }

        parts.push(content);
    }

    if (runtimeAddendum && runtimeAddendum.trim() !== '') {
        parts.push(runtimeAddendum);
    }

    return parts.join('\n\n');
}
