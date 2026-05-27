/**
 * Property test for threaded-reply-parser.ts — Property 3.
 *
 * Property 3: For any batch of N distinct inbound messages (N >= 1),
 * a correctly delimited response produces exactly N segments, each with
 * inReplyTo matching the corresponding inbound message ID, no duplicates,
 * no orphans.
 *
 * Requirements: 3.1, 3.2
 */
import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { parseThreadedResponse } from './threaded-reply-parser.js';

/** Build a well-formed delimited response for N messages. */
function buildDelimitedResponse(messages: Array<{ id: string; content: string }>): string {
    return messages
        .map((m) => `===REPLY:${m.id}===\n${m.content}\n===END===`)
        .join('\n');
}

const arbMessageId = fc
    .string({ minLength: 2, maxLength: 16 })
    .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));

const arbContent = fc.string({ minLength: 1, maxLength: 200 }).filter(
    (s) => !s.includes('===') && s.trim().length > 0,
);

describe('Property 3: threaded reply maps responses to source messages', () => {
    it('for any N inbound messages with well-formed delimiters, produces exactly N segments', () => {
        fc.assert(
            fc.property(
                fc.uniqueArray(arbMessageId, { minLength: 1, maxLength: 6 }),
                fc.array(arbContent, { minLength: 1, maxLength: 6 }),
                (ids, contents) => {
                    // Align arrays (zip to shorter)
                    const n = Math.min(ids.length, contents.length);
                    if (n === 0) return true;
                    const messages = ids.slice(0, n).map((id, i) => ({
                        id,
                        content: contents[i],
                    }));

                    const raw = buildDelimitedResponse(messages);
                    const inbound = messages.map((m) => ({ id: m.id }));
                    const result = parseThreadedResponse(raw, inbound);

                    // Exactly N segments
                    expect(result).toHaveLength(n);

                    // Each inReplyTo matches a distinct inbound ID
                    const replyIds = result.map((r) => r.inReplyTo);
                    const inboundIds = messages.map((m) => m.id);
                    for (const id of replyIds) {
                        expect(inboundIds).toContain(id);
                    }

                    // No duplicates
                    expect(new Set(replyIds).size).toBe(replyIds.length);

                    // No orphans (every inbound ID has a reply)
                    for (const id of inboundIds) {
                        expect(replyIds).toContain(id);
                    }

                    return true;
                },
            ),
            { numRuns: 200 },
        );
    });

    it('single message without delimiters is always handled (fallback)', () => {
        fc.assert(
            fc.property(arbMessageId, arbContent, (id, content) => {
                const result = parseThreadedResponse(content, [{ id }]);
                expect(result).toHaveLength(1);
                expect(result[0].inReplyTo).toBe(id);
            }),
            { numRuns: 200 },
        );
    });
});
