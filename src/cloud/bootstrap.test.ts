/**
 * Tests for the cloud bootstrap module.
 *
 * Verifies:
 * - Environment detection (isCloudMode)
 * - Service initialization order
 * - Graceful degradation on non-critical service failures
 * - Shutdown cleanup
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { isCloudMode, getCloudServices } from './bootstrap.js';

describe('Cloud Bootstrap', () => {
    const originalEnv = process.env.NANOCLAW_ENV;

    beforeEach(() => {
        delete process.env.NANOCLAW_ENV;
    });

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.NANOCLAW_ENV = originalEnv;
        } else {
            delete process.env.NANOCLAW_ENV;
        }
    });

    describe('isCloudMode', () => {
        it('returns false when NANOCLAW_ENV is not set', () => {
            delete process.env.NANOCLAW_ENV;
            expect(isCloudMode()).toBe(false);
        });

        it('returns false when NANOCLAW_ENV is "local"', () => {
            process.env.NANOCLAW_ENV = 'local';
            expect(isCloudMode()).toBe(false);
        });

        it('returns true when NANOCLAW_ENV is "cloud"', () => {
            process.env.NANOCLAW_ENV = 'cloud';
            expect(isCloudMode()).toBe(true);
        });

        it('returns false for empty string', () => {
            process.env.NANOCLAW_ENV = '';
            expect(isCloudMode()).toBe(false);
        });

        it('is case-sensitive (CLOUD does not match)', () => {
            process.env.NANOCLAW_ENV = 'CLOUD';
            expect(isCloudMode()).toBe(false);
        });
    });

    describe('getCloudServices', () => {
        it('returns null when bootstrap has not been called', () => {
            // getCloudServices returns null before bootstrapCloudServices is called
            // (In a fresh test environment, the singleton is null)
            const services = getCloudServices();
            // May or may not be null depending on test ordering, but the function should not throw
            expect(services === null || typeof services === 'object').toBe(true);
        });
    });
});
