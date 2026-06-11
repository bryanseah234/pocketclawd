/**
 * Regression test for sub-agent response content wrap (C2).
 *
 * Bug context (2026-05-28): src/index.ts cloud response poll passed the
 * sub-agent's plain-text content directly into deliveryAdapter.deliver(),
 * which calls JSON.parse on the content string. This produced runtime
 * errors like:
 *   Failed to handle agent response... Unexpected token 'P', "Please rep"... is not valid JSON
 *
 * Fix: wrap rawContent as JSON.stringify({ text: rawContent }) before
 * passing to deliveryAdapter.deliver. The adapter's internal JSON.parse
 * then yields { text: '...' } which channel adapters expect.
 *
 * This test verifies (a) the wrap behavior is correct in isolation and
 * (b) the literal source line in src/index.ts still implements it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function wrapForDelivery(rawContent: string): string {
    return JSON.stringify({ text: rawContent });
}

describe('sub-agent response content wrap (regression)', () => {
    it('wraps plain text into JSON.parseable {text} envelope', () => {
        const raw = "Hello! Here's a quick reply.";
        const wrapped = wrapForDelivery(raw);
        const parsed = JSON.parse(wrapped);
        expect(parsed).toEqual({ text: raw });
    });

    it('handles multi-line content with newlines', () => {
        const raw = 'line1\nline2\nline3';
        const wrapped = wrapForDelivery(raw);
        const parsed = JSON.parse(wrapped);
        expect(parsed.text).toBe(raw);
    });

    it('handles content with embedded JSON-like substrings', () => {
        const raw = 'You said {"foo": "bar"} earlier.';
        const wrapped = wrapForDelivery(raw);
        const parsed = JSON.parse(wrapped);
        expect(parsed.text).toBe(raw);
    });

    it('handles content with quotes and backslashes', () => {
        const raw = 'He said "use \\path" — try it.';
        const wrapped = wrapForDelivery(raw);
        const parsed = JSON.parse(wrapped);
        expect(parsed.text).toBe(raw);
    });

    it('handles empty content (silent guard upstream)', () => {
        const wrapped = wrapForDelivery('');
        expect(JSON.parse(wrapped)).toEqual({ text: '' });
    });

    it('source: src/index.ts still wraps via JSON.stringify({ text: rawContent })', () => {
        // Locate src/index.ts deterministically. The vitest cwd is repo root.
        const path = join(process.cwd(), 'src', 'index.ts');
        const src = readFileSync(path, 'utf-8');
        // The exact wrap line must remain present.
        expect(src).toContain('JSON.stringify({ text: rawContent })');
        // And we still pass `content` (the wrapped string) into the adapter.
        // Tolerant of the kind-var rename (kind -> resolvedKind): the invariant is
        // that the WRAPPED `content` (not rawContent) is the last deliver() arg.
        expect(src).toMatch(/deliveryAdapter\.deliver\(channelType, platformId, threadId, \w+, content\)/);
    });

    it('source: src/index.ts does NOT pass rawContent directly to deliver()', () => {
        const path = join(process.cwd(), 'src', 'index.ts');
        const src = readFileSync(path, 'utf-8');
        // Catches the regression where someone removes the wrap.
        expect(src).not.toMatch(/deliveryAdapter\.deliver\([^)]*rawContent[^)]*\)/);
    });
});
