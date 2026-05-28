/**
 * Graceful Restart Trigger — signals the orchestrator to complete in-progress
 * work and then restart.
 *
 * The Clawd host process runs as a Windows Scheduled Task. On receiving
 * SIGTERM/SIGINT, the main `shutdown()` handler in `src/index.ts` drains
 * in-flight work (delivery polls, response polls, channel adapters, cloud
 * services) and exits with code 0. The scheduled task is configured to
 * restart on exit, so the process comes back up automatically.
 *
 * This module provides a programmatic way to trigger that sequence from the
 * admin settings "Apply & Restart" flow.
 *
 * Requirements: 4.1, 4.3, 4.4
 */

import { log } from '../../../log.js';

// ── Configuration ──

/**
 * Delay (ms) before sending the shutdown signal. This gives the HTTP response
 * time to flush back to the client and allows any in-progress message
 * processing iteration to complete its current cycle.
 *
 * The actual graceful drain happens inside the main shutdown() handler —
 * this delay is just a buffer so the API response reaches the browser.
 */
const RESTART_DELAY_MS = parseInt(process.env.RESTART_DELAY_MS || '2000', 10);

// ── State ──

/** Tracks whether a restart has already been scheduled (prevents double-fire). */
let restartScheduled = false;

// ── Public API ──

/**
 * Trigger a graceful restart of the orchestrator process.
 *
 * The function schedules a SIGTERM after a short delay so that:
 * 1. The HTTP response can be sent back to the admin client.
 * 2. The main shutdown() handler in src/index.ts runs its drain sequence
 *    (shutdown callbacks → stop polls → teardown adapters → exit 0).
 * 3. The process manager (Windows Scheduled Task) restarts the process.
 *
 * Returns immediately with a success/failure indication. The actual restart
 * happens asynchronously after the delay.
 *
 * If a restart is already scheduled, returns success without scheduling another.
 */
export async function triggerGracefulRestart(): Promise<{ success: boolean; message: string }> {
    // Prevent multiple restarts from being queued
    if (restartScheduled) {
        return {
            success: true,
            message: 'Restart already scheduled. The service will restart momentarily.',
        };
    }

    try {
        restartScheduled = true;

        log.info('Graceful restart triggered via admin settings', {
            delayMs: RESTART_DELAY_MS,
            pid: process.pid,
        });

        // Schedule the signal after a delay so the HTTP response can flush.
        // The timer is unref'd so it doesn't keep the event loop alive if
        // something else triggers shutdown first.
        const timer = setTimeout(() => {
            log.info('Sending SIGTERM to self for graceful restart');
            try {
                process.kill(process.pid, 'SIGTERM');
            } catch (err) {
                // On Windows, process.kill with SIGTERM may not work the same way.
                // Fall back to process.exit which will still trigger 'exit' handlers.
                log.warn('SIGTERM self-signal failed, falling back to process.exit(0)', { err });
                process.exit(0);
            }
        }, RESTART_DELAY_MS);

        // Don't let this timer keep the process alive
        if (typeof timer.unref === 'function') {
            timer.unref();
        }

        return {
            success: true,
            message: `Restart scheduled. Service will restart in ~${Math.round(RESTART_DELAY_MS / 1000)}s after draining in-progress work.`,
        };
    } catch (err) {
        restartScheduled = false;
        const message = err instanceof Error ? err.message : 'Unknown error scheduling restart';
        log.error('Failed to schedule graceful restart', { err });
        return {
            success: false,
            message: `Restart failed: ${message}`,
        };
    }
}

/**
 * Check whether a restart is currently pending.
 * Useful for health checks and status endpoints.
 */
export function isRestartPending(): boolean {
    return restartScheduled;
}

/**
 * Reset the restart state. Only used in tests.
 * @internal
 */
export function _resetRestartState(): void {
    restartScheduled = false;
}
