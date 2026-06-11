/**
 * Unit tests for threaded-reply-parser.ts.
 * Requirements: 3.1, 3.2
 */
import { describe, it, expect } from 'bun:test';
import { parseThreadedResponse } from './threaded-reply-parser.js';

const msg = (id: string) => ({ id });

describe('parseThreadedResponse — no delimiters', () => {
    it('single inbound message → single segment, inReplyTo=inbound[0].id', () => {
        const result = parseThreadedResponse('Hello world', [msg('m1')]);
        expect(result).toHaveLength(1);
        expect(result[0].inReplyTo).toBe('m1');
        expect(result[0].content).toBe('Hello world');
    });

    it('multiple inbound but no delimiters → single fallback segment', () => {
        const result = parseThreadedResponse('One response', [msg('m1'), msg('m2'), msg('m3')]);
        expect(result).toHaveLength(1);
        expect(result[0].inReplyTo).toBe('m1');
    });

    it('empty raw output → single empty segment for first inbound', () => {
        const result = parseThreadedResponse('   ', [msg('m1')]);
        expect(result).toHaveLength(1);
        expect(result[0].content).toBe('');
    });

    it('empty raw + empty inbound → empty array', () => {
        const result = parseThreadedResponse('', []);
        expect(result).toHaveLength(0);
    });
});

describe('parseThreadedResponse — valid delimiters', () => {
    it('3 messages with delimiters → 3 segments with correct inReplyTo', () => {
        const raw = [
            '===REPLY:m1===',
            'Answer to first.',
            '===END===',
            '===REPLY:m2===',
            'Answer to second.',
            '===END===',
            '===REPLY:m3===',
            'Answer to third.',
            '===END===',
        ].join('\n');

        const result = parseThreadedResponse(raw, [msg('m1'), msg('m2'), msg('m3')]);
        expect(result).toHaveLength(3);
        expect(result[0]).toEqual({ inReplyTo: 'm1', content: 'Answer to first.' });
        expect(result[1]).toEqual({ inReplyTo: 'm2', content: 'Answer to second.' });
        expect(result[2]).toEqual({ inReplyTo: 'm3', content: 'Answer to third.' });
    });

    it('multi-line content within a segment is preserved', () => {
        const raw = '===REPLY:m1===\nLine 1\nLine 2\nLine 3\n===END===';
        const result = parseThreadedResponse(raw, [msg('m1')]);
        expect(result).toHaveLength(1);
        expect(result[0].content).toContain('Line 1');
        expect(result[0].content).toContain('Line 3');
    });

    it('single delimiter for single inbound → one segment', () => {
        const raw = '===REPLY:msg-abc===\nGot it.\n===END===';
        const result = parseThreadedResponse(raw, [msg('msg-abc')]);
        expect(result).toHaveLength(1);
        expect(result[0].inReplyTo).toBe('msg-abc');
        expect(result[0].content).toBe('Got it.');
    });
});

describe('parseThreadedResponse — malformed delimiters', () => {
    it('delimiter IDs not matching inbound → fallback single segment', () => {
        const raw = '===REPLY:unknown-id===\nContent\n===END===';
        const result = parseThreadedResponse(raw, [msg('m1')]);
        expect(result).toHaveLength(1);
        expect(result[0].inReplyTo).toBe('m1');
        expect(result[0].content).toBe(raw.trim());
    });

    it('unclosed REPLY block (no END) → flushes remaining as segment', () => {
        const raw = '===REPLY:m1===\nContent without end';
        const result = parseThreadedResponse(raw, [msg('m1')]);
        expect(result).toHaveLength(1);
        expect(result[0].inReplyTo).toBe('m1');
        expect(result[0].content).toBe('Content without end');
    });
});
