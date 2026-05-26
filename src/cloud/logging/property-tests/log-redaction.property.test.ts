/**
 * Property-Based Test: Log redaction completeness (Property 7)
 *
 * For any log string containing sensitive patterns (strings matching API key
 * formats, bearer tokens, password fields, or message content fields), the
 * redaction function SHALL replace all sensitive values with a mask placeholder
 * while preserving the non-sensitive structure of the log entry.
 *
 * Feature: nanoclaw-aws-deployment, Property 7: Log redaction completeness
 * **Validates: Requirements REQ-6.2**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { redactSensitiveData, REDACTION_MASK } from '../index.js';

// ── Generators for sensitive patterns ──

/** Generate a realistic API key like sk-... or sk_live_... */
const apiKeyArb = fc.tuple(
    fc.constantFrom('sk-', 'sk_live_', 'sk_test_', 'pk-', 'rk-'),
    fc.stringMatching(/^[A-Za-z0-9_-]{24,48}$/),
).map(([prefix, suffix]) => `${prefix}${suffix}`);

/** Generate a Bearer token */
const bearerTokenArb = fc.stringMatching(/^[A-Za-z0-9._~+/=-]{20,80}$/)
    .map((token) => `Bearer ${token}`);

/** Generate a JWT-like token (three base64url segments) */
const jwtArb = fc.tuple(
    fc.stringMatching(/^[A-Za-z0-9_-]{10,40}$/),
    fc.stringMatching(/^[A-Za-z0-9_-]{10,40}$/),
    fc.stringMatching(/^[A-Za-z0-9_-]{10,40}$/),
).map(([header, payload, sig]) => `eyJ${header}.eyJ${payload}.${sig}`);

/** Generate a password field in JSON format */
const passwordJsonArb = fc.tuple(
    fc.constantFrom('password', 'passwd', 'secret', 'token', 'api_key', 'apiKey', 'access_token', 'refresh_token', 'client_secret'),
    fc.stringMatching(/^[A-Za-z0-9!@#$%^&*]{4,32}$/),
).map(([key, value]) => `"${key}": "${value}"`);

/** Generate a password field in key=value format */
const passwordKvArb = fc.tuple(
    fc.constantFrom('password', 'passwd', 'secret', 'token', 'api_key', 'apiKey', 'access_token', 'refresh_token', 'client_secret'),
    fc.stringMatching(/^[A-Za-z0-9]{4,32}$/),
).map(([key, value]) => `${key}=${value}`);

/** Generate a message content field in JSON format */
const messageContentJsonArb = fc.tuple(
    fc.constantFrom('messageContent', 'message_content', 'body', 'messageBody', 'message_body'),
    fc.stringMatching(/^[A-Za-z0-9 .,!?]{5,60}$/),
).map(([key, value]) => `"${key}": "${value}"`);

/** Generate an AWS access key */
const awsKeyArb = fc.stringMatching(/^[A-Z0-9]{16}$/)
    .map((suffix) => `AKIA${suffix}`);

/** Generate surrounding non-sensitive text */
const surroundingTextArb = fc.stringMatching(/^[a-z0-9 .:_\-[\]{}()]{0,40}$/);

/** Embed a sensitive value within surrounding text */
function embedSensitive(sensitiveArb: fc.Arbitrary<string>) {
    return fc.tuple(surroundingTextArb, sensitiveArb, surroundingTextArb)
        .map(([before, sensitive, after]) => ({
            full: `${before} ${sensitive} ${after}`,
            sensitive,
        }));
}

describe('Property 7: Log redaction completeness', { timeout: 60_000 }, () => {
    it('API keys (sk-..., pk-..., rk-...) are fully redacted from any log string', async () => {
        await fc.assert(
            fc.property(embedSensitive(apiKeyArb), ({ full, sensitive }) => {
                const redacted = redactSensitiveData(full);
                expect(redacted).not.toContain(sensitive);
                expect(redacted).toContain(REDACTION_MASK);
            }),
            { numRuns: 100 },
        );
    });

    it('Bearer tokens are fully redacted, preserving "Bearer" prefix', async () => {
        await fc.assert(
            fc.property(embedSensitive(bearerTokenArb), ({ full, sensitive }) => {
                // Extract the actual token value (after "Bearer ")
                const tokenValue = sensitive.replace('Bearer ', '');
                const redacted = redactSensitiveData(full);
                expect(redacted).not.toContain(tokenValue);
                expect(redacted).toContain(`Bearer ${REDACTION_MASK}`);
            }),
            { numRuns: 100 },
        );
    });

    it('JWT tokens are fully redacted from any log string', async () => {
        await fc.assert(
            fc.property(embedSensitive(jwtArb), ({ full, sensitive }) => {
                const redacted = redactSensitiveData(full);
                expect(redacted).not.toContain(sensitive);
                expect(redacted).toContain(REDACTION_MASK);
            }),
            { numRuns: 100 },
        );
    });

    it('password/secret JSON fields have values redacted, keys preserved', async () => {
        await fc.assert(
            fc.property(embedSensitive(passwordJsonArb), ({ full, sensitive }) => {
                // Extract the key and value from the pattern
                const match = sensitive.match(/"([^"]+)":\s*"([^"]+)"/);
                if (!match) return;
                const [, key, value] = match;
                const redacted = redactSensitiveData(full);
                // The key should still be present
                expect(redacted).toContain(`"${key}"`);
                // The sensitive value should be replaced
                expect(redacted).not.toContain(`"${value}"`);
                expect(redacted).toContain(REDACTION_MASK);
            }),
            { numRuns: 100 },
        );
    });

    it('password/secret key=value fields have values redacted, keys preserved', async () => {
        await fc.assert(
            fc.property(embedSensitive(passwordKvArb), ({ full, sensitive }) => {
                // Extract key and value
                const match = sensitive.match(/([^=]+)=(.+)/);
                if (!match) return;
                const [, key, value] = match;
                const redacted = redactSensitiveData(full);
                // The key should still be present
                expect(redacted).toContain(key);
                // The sensitive value should be replaced
                expect(redacted).not.toContain(`=${value}`);
                expect(redacted).toContain(REDACTION_MASK);
            }),
            { numRuns: 100 },
        );
    });

    it('message content JSON fields have values redacted, keys preserved', async () => {
        await fc.assert(
            fc.property(embedSensitive(messageContentJsonArb), ({ full, sensitive }) => {
                const match = sensitive.match(/"([^"]+)":\s*"([^"]+)"/);
                if (!match) return;
                const [, key, value] = match;
                const redacted = redactSensitiveData(full);
                expect(redacted).toContain(`"${key}"`);
                expect(redacted).not.toContain(`"${value}"`);
                expect(redacted).toContain(REDACTION_MASK);
            }),
            { numRuns: 100 },
        );
    });

    it('AWS access keys (AKIA...) are fully redacted from any log string', async () => {
        await fc.assert(
            fc.property(embedSensitive(awsKeyArb), ({ full, sensitive }) => {
                const redacted = redactSensitiveData(full);
                expect(redacted).not.toContain(sensitive);
                expect(redacted).toContain(REDACTION_MASK);
            }),
            { numRuns: 100 },
        );
    });

    it('non-sensitive log structure is preserved after redaction', async () => {
        const structuredLogArb = fc.tuple(
            fc.constantFrom('INFO', 'WARNING', 'ERROR'),
            fc.stringMatching(/^[a-z]{3,15}$/),
            apiKeyArb,
        ).map(([level, component, apiKey]) => ({
            logString: `[${level}] ${component}: processing request with key ${apiKey}`,
            level,
            component,
            apiKey,
        }));

        await fc.assert(
            fc.property(structuredLogArb, ({ logString, level, component, apiKey }) => {
                const redacted = redactSensitiveData(logString);
                // Structure preserved
                expect(redacted).toContain(`[${level}]`);
                expect(redacted).toContain(`${component}:`);
                expect(redacted).toContain('processing request with key');
                // Sensitive data removed
                expect(redacted).not.toContain(apiKey);
            }),
            { numRuns: 100 },
        );
    });

    it('multiple sensitive values in a single log string are all redacted', async () => {
        const multiSensitiveArb = fc.tuple(
            apiKeyArb,
            bearerTokenArb,
            passwordJsonArb,
        ).map(([apiKey, bearer, passwordField]) => ({
            logString: `Request from ${apiKey} with auth ${bearer} and config ${passwordField}`,
            apiKey,
            bearerToken: bearer.replace('Bearer ', ''),
        }));

        await fc.assert(
            fc.property(multiSensitiveArb, ({ logString, apiKey, bearerToken }) => {
                const redacted = redactSensitiveData(logString);
                expect(redacted).not.toContain(apiKey);
                expect(redacted).not.toContain(bearerToken);
                // Non-sensitive parts preserved
                expect(redacted).toContain('Request from');
                expect(redacted).toContain('with auth');
                expect(redacted).toContain('and config');
            }),
            { numRuns: 100 },
        );
    });
});
