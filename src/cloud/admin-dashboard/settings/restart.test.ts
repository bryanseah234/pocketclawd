/**
 * Unit tests for the graceful restart trigger module.
 *
 * Requirements: 4.1, 4.3, 4.4
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the log module to prevent actual logging during tests
vi.mock('../../../log.js', () => ({
    log: { info: () => { }, warn: () => { }, error: () => { } },
}));

// Use a small delay for faster tests
process.env.RESTART_DELAY_MS = '100';

// Dynamic import after mocks are established
const { triggerGracefulRestart, isRestartPending, _resetRestartState } = await import(
    './restart.js'
);

describe('restart integration', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        _resetRestartState();
        vi.spyOn(process, 'kill').mockImplementation(() => true);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe('triggerGracefulRestart', () => {
        it('returns success on first call', async () => {
            const result = await triggerGracefulRestart();

            expect(result.success).toBe(true);
            expect(result.message).toContain('Restart scheduled');
        });

        it('prevents double-fire — second call returns success without scheduling another restart', async () => {
            const first = await triggerGracefulRestart();
            const second = await triggerGracefulRestart();

            expect(first.success).toBe(true);
            expect(second.success).toBe(true);
            expect(second.message).toContain('already scheduled');

            // Advance timers and verify process.kill is only called once
            vi.advanceTimersByTime(200);
            expect(process.kill).toHaveBeenCalledTimes(1);
        });

        it('sends SIGTERM to self after the configured delay', async () => {
            await triggerGracefulRestart();

            // Not called yet before delay elapses
            expect(process.kill).not.toHaveBeenCalled();

            // Advance past the delay
            vi.advanceTimersByTime(200);

            expect(process.kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
        });

        it('returns failure when an error is thrown during scheduling', async () => {
            // Mock setTimeout to throw an error to simulate scheduling failure
            vi.useRealTimers();
            const originalSetTimeout = globalThis.setTimeout;
            vi.stubGlobal('setTimeout', () => {
                throw new Error('Timer allocation failed');
            });

            _resetRestartState();
            const result = await triggerGracefulRestart();

            expect(result.success).toBe(false);
            expect(result.message).toContain('Timer allocation failed');

            // Restore setTimeout
            vi.stubGlobal('setTimeout', originalSetTimeout);
            vi.useFakeTimers();
        });
    });

    describe('isRestartPending', () => {
        it('returns false initially', () => {
            expect(isRestartPending()).toBe(false);
        });

        it('returns true after triggerGracefulRestart is called', async () => {
            await triggerGracefulRestart();
            expect(isRestartPending()).toBe(true);
        });
    });

    describe('_resetRestartState', () => {
        it('resets the pending flag back to false', async () => {
            await triggerGracefulRestart();
            expect(isRestartPending()).toBe(true);

            _resetRestartState();
            expect(isRestartPending()).toBe(false);
        });

        it('allows a new restart to be scheduled after reset', async () => {
            await triggerGracefulRestart();
            _resetRestartState();

            const result = await triggerGracefulRestart();
            expect(result.success).toBe(true);
            expect(result.message).toContain('Restart scheduled');
        });
    });
});
