/**
 * B2 (Wave 6): PII redaction tests for the CloudWatch logger.
 *
 * Asserts that phone numbers, WhatsApp JIDs, and email addresses are
 * masked before any log entry leaves the process.
 */

import { describe, it, expect } from 'vitest';
import { redactSensitiveData, REDACTION_MASK } from './index.js';

describe('PII redaction (B2)', () => {
    it('redacts E.164 phone numbers', () => {
        const cases = [
            'Got message from +6584731565',
            'phone=+15551234567',
            'multi: +6512345678 and +442012345678',
        ];
        for (const input of cases) {
            const out = redactSensitiveData(input);
            expect(out).not.toMatch(/\+\d{6,}/);
            expect(out).toContain(REDACTION_MASK);
        }
    });

    it('redacts WhatsApp JIDs', () => {
        const out = redactSensitiveData('thread=6584731565@s.whatsapp.net');
        expect(out).not.toContain('6584731565@s.whatsapp.net');
        expect(out).toContain(REDACTION_MASK);
    });

    it('redacts email addresses', () => {
        const cases = [
            'user shotsbyseah234@gmail.com signed up',
            'cc: alice+filter@example.co.uk',
        ];
        for (const input of cases) {
            const out = redactSensitiveData(input);
            expect(out).not.toMatch(/[a-z]+@[a-z.]+\.[a-z]+/i);
            expect(out).toContain(REDACTION_MASK);
        }
    });

    it('preserves non-PII text alongside redactions', () => {
        const out = redactSensitiveData('User +6584731565 said hello at 09:00');
        expect(out).toContain('User');
        expect(out).toContain('said hello');
        expect(out).toContain('09:00');
        expect(out).not.toContain('+6584731565');
    });

    it('redacts multiple PII types in one log line', () => {
        const out = redactSensitiveData('contact=alice@x.com phone=+6584731565 jid=6584731565@s.whatsapp.net');
        expect(out).not.toContain('alice@x.com');
        expect(out).not.toContain('+6584731565');
        expect(out).not.toContain('6584731565@s.whatsapp.net');
    });
});
