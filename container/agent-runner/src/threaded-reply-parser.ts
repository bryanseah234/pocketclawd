/**
 * Threaded Reply Parser — splits a Claude response into per-message segments
 * for WhatsApp threaded reply routing.
 *
 * When the agent-runner processes a batch of inbound messages, it instructs
 * Claude (via system prompt) to delimit each reply segment using:
 *
 *   ===REPLY:{messageId}===
 *   {content for that message}
 *   ===END===
 *
 * This module parses that output and returns one segment per inbound message,
 * each tagged with the correct `inReplyTo` message ID.
 *
 * Edge cases:
 *   - Single inbound + no delimiters  → single segment, inReplyTo = inbound[0].id
 *   - Malformed / partial delimiter   → fallback to single segment, warn in log
 *
 * Requirements: 3.1, 3.2
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface InboundRef {
    /** The source message ID this reply segment corresponds to. */
    id: string;
}

export interface ReplySegment {
    /** The inbound message ID this segment replies to. */
    inReplyTo: string;
    /** The reply text for this segment. */
    content: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const REPLY_OPEN_PATTERN = /^===REPLY:(.+)===$/;
const REPLY_CLOSE = '===END===';

// ── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parse a Claude response string into per-source-message reply segments.
 *
 * @param raw       The raw Claude output (may or may not contain delimiters).
 * @param inbound   The ordered list of inbound messages that were processed.
 * @returns         One ReplySegment per delimiter found, or a single segment
 *                  wrapping the entire response if no delimiters are present.
 */
export function parseThreadedResponse(
    raw: string,
    inbound: InboundRef[],
): ReplySegment[] {
    // Guard: empty output
    if (!raw.trim()) {
        return inbound.length > 0
            ? [{ inReplyTo: inbound[0].id, content: '' }]
            : [];
    }

    const lines = raw.split('\n');
    const segments: ReplySegment[] = [];
    let currentId: string | null = null;
    const contentLines: string[] = [];

    for (const line of lines) {
        const openMatch = REPLY_OPEN_PATTERN.exec(line.trim());

        if (openMatch) {
            // Flush previous segment if any
            if (currentId !== null) {
                segments.push({ inReplyTo: currentId, content: contentLines.join('\n').trim() });
                contentLines.length = 0;
            }
            currentId = openMatch[1].trim();
            continue;
        }

        if (line.trim() === REPLY_CLOSE) {
            if (currentId !== null) {
                segments.push({ inReplyTo: currentId, content: contentLines.join('\n').trim() });
                contentLines.length = 0;
                currentId = null;
            }
            continue;
        }

        if (currentId !== null) {
            contentLines.push(line);
        }
    }

    // Flush any unclosed segment (malformed: REPLY open without END)
    if (currentId !== null && contentLines.length > 0) {
        console.warn('[threaded-reply-parser] unclosed delimiter — flushing remaining content', {
            messageId: currentId,
        });
        segments.push({ inReplyTo: currentId, content: contentLines.join('\n').trim() });
    }

    // No delimiters found — fall back to single segment
    if (segments.length === 0) {
        if (inbound.length === 0) return [];
        return [{ inReplyTo: inbound[0].id, content: raw.trim() }];
    }

    // Malformed: delimiter IDs don't match inbound IDs — log and return as-is
    const inboundIds = new Set(inbound.map((m) => m.id));
    const mismatch = segments.some((s) => !inboundIds.has(s.inReplyTo));
    if (mismatch) {
        console.warn('[threaded-reply-parser] segment IDs do not match inbound IDs — returning raw fallback', {
            segmentIds: segments.map((s) => s.inReplyTo),
            inboundIds: [...inboundIds],
        });
        return [{ inReplyTo: inbound[0].id, content: raw.trim() }];
    }

    return segments;
}
