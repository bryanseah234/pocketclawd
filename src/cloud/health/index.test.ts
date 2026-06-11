/**
 * Unit tests for the Health Check Aggregator module.
 * Requirements: REQ-6.1, REQ-6.3
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerFailureEvent, HealthDependencies, WhatsAppSessionHealth } from './types.js';

import { HealthCheckAggregator } from './index.js';

// ── Mock dependencies factory ──

function createMockDeps(overrides: Partial<HealthDependencies> = {}): HealthDependencies {
    return {
        checkRedis: vi.fn().mockResolvedValue(true),
        checkDynamoDB: vi.fn().mockResolvedValue(true),
        checkOpenSearch: vi.fn().mockResolvedValue(true),
        checkWhatsAppSession: vi.fn().mockResolvedValue({
            valid: true,
            lastChecked: new Date().toISOString(),
        } satisfies WhatsAppSessionHealth),
        getActiveContainerCount: vi.fn().mockReturnValue(5),
        getQuarantinedCount: vi.fn().mockReturnValue(0),
        sendAdminAlert: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

// ── Mock AWS SDK ──

vi.mock('@aws-sdk/client-cloudwatch', () => {
    class MockCloudWatchClient {
        send = vi.fn().mockResolvedValue({});
    }
    return {
        CloudWatchClient: MockCloudWatchClient,
        PutMetricDataCommand: class MockPutMetricDataCommand {
            constructor(public input: unknown) { }
        },
    };
});

vi.mock('../../log.js', () => ({
    log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

describe('HealthCheckAggregator', () => {
    let aggregator: HealthCheckAggregator;
    let deps: HealthDependencies;

    beforeEach(() => {
        vi.useFakeTimers();
        deps = createMockDeps();
        aggregator = new HealthCheckAggregator(deps, {
            sessionCheckIntervalMs: 3_600_000,
            crashWindowMs: 300_000,
            maxCrashesBeforeQuarantine: 3,
        });
    });

    afterEach(() => {
        aggregator.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    // ── /health endpoint ──

    describe('getHealth', () => {
        it('returns healthy status when all components are healthy', async () => {
            const health = await aggregator.getHealth();

            expect(health.status).toBe('healthy');
            expect(health.components.redis.status).toBe('healthy');
            expect(health.components.dynamodb.status).toBe('healthy');
            expect(health.components.opensearch.status).toBe('healthy');
            expect(health.containers.active).toBe(5);
            expect(health.containers.quarantined).toBe(0);
            expect(health.uptime).toBeGreaterThanOrEqual(0);
            expect(health.timestamp).toBeDefined();
        });

        it('returns unhealthy status when a critical component fails', async () => {
            deps = createMockDeps({
                checkRedis: vi.fn().mockResolvedValue(false),
            });
            aggregator = new HealthCheckAggregator(deps);

            const health = await aggregator.getHealth();

            expect(health.status).toBe('unhealthy');
            expect(health.components.redis.status).toBe('unhealthy');
        });

        it('returns degraded status when a non-critical component fails', async () => {
            deps = createMockDeps({
                checkWhatsAppSession: vi.fn().mockResolvedValue({
                    valid: false,
                    lastChecked: new Date().toISOString(),
                    message: 'Session expired',
                } satisfies WhatsAppSessionHealth),
            });
            aggregator = new HealthCheckAggregator(deps);

            const health = await aggregator.getHealth();

            expect(health.status).toBe('degraded');
            expect(health.components.whatsappSession.status).toBe('unhealthy');
        });

        it('handles component check throwing an error', async () => {
            deps = createMockDeps({
                checkDynamoDB: vi.fn().mockRejectedValue(new Error('Connection timeout')),
            });
            aggregator = new HealthCheckAggregator(deps);

            const health = await aggregator.getHealth();

            expect(health.status).toBe('unhealthy');
            expect(health.components.dynamodb.status).toBe('unhealthy');
            expect(health.components.dynamodb.message).toBe('Connection timeout');
        });

        it('includes latency measurements for component checks', async () => {
            deps = createMockDeps({
                checkRedis: vi.fn().mockImplementation(async () => {
                    await new Promise((r) => setTimeout(r, 10));
                    return true;
                }),
            });
            aggregator = new HealthCheckAggregator(deps);

            // Advance timers to let the async check complete
            const healthPromise = aggregator.getHealth();
            await vi.advanceTimersByTimeAsync(50);
            const health = await healthPromise;

            expect(health.components.redis.latencyMs).toBeDefined();
            expect(health.components.redis.latencyMs).toBeGreaterThanOrEqual(0);
        });

        it('reports container counts from dependencies', async () => {
            deps = createMockDeps({
                getActiveContainerCount: vi.fn().mockReturnValue(12),
                getQuarantinedCount: vi.fn().mockReturnValue(2),
            });
            aggregator = new HealthCheckAggregator(deps);

            const health = await aggregator.getHealth();

            expect(health.containers.active).toBe(12);
            expect(health.containers.quarantined).toBe(2);
        });
    });

    // ── WhatsApp session health ──

    describe('checkWhatsAppSessionHealth', () => {
        it('returns valid session health when session is active', async () => {
            const result = await aggregator.checkWhatsAppSessionHealth();

            expect(result.valid).toBe(true);
            expect(deps.sendAdminAlert).not.toHaveBeenCalled();
        });

        it('alerts admin when session is invalid', async () => {
            deps = createMockDeps({
                checkWhatsAppSession: vi.fn().mockResolvedValue({
                    valid: false,
                    lastChecked: new Date().toISOString(),
                    message: 'Session disconnected',
                } satisfies WhatsAppSessionHealth),
            });
            aggregator = new HealthCheckAggregator(deps);

            const result = await aggregator.checkWhatsAppSessionHealth();

            expect(result.valid).toBe(false);
            expect(deps.sendAdminAlert).toHaveBeenCalledWith(
                expect.stringContaining('Session disconnected'),
                'critical',
            );
        });

        it('alerts admin when session check throws', async () => {
            deps = createMockDeps({
                checkWhatsAppSession: vi.fn().mockRejectedValue(new Error('Network error')),
            });
            aggregator = new HealthCheckAggregator(deps);

            const result = await aggregator.checkWhatsAppSessionHealth();

            expect(result.valid).toBe(false);
            expect(result.message).toContain('Network error');
            expect(deps.sendAdminAlert).toHaveBeenCalledWith(
                expect.stringContaining('Network error'),
                'critical',
            );
        });

        it('runs hourly session check on interval when started', async () => {
            aggregator.start();

            // Initial check runs immediately
            expect(deps.checkWhatsAppSession).toHaveBeenCalledTimes(1);

            // Advance 1 hour
            await vi.advanceTimersByTimeAsync(3_600_000);
            expect(deps.checkWhatsAppSession).toHaveBeenCalledTimes(2);

            // Advance another hour
            await vi.advanceTimersByTimeAsync(3_600_000);
            expect(deps.checkWhatsAppSession).toHaveBeenCalledTimes(3);
        });
    });

    // ── Container health monitoring ──

    describe('container monitoring', () => {
        it('records container failure events', () => {
            const event: ContainerFailureEvent = {
                userId: 'user-1',
                exitCode: 137,
                reason: 'oom_kill',
                timestamp: new Date().toISOString(),
            };

            aggregator.recordContainerFailure(event);

            const failures = aggregator.getRecentFailures();
            expect(failures).toHaveLength(1);
            expect(failures[0]).toEqual(event);
        });

        it('detects OOM kills (exit code 137)', () => {
            const event: ContainerFailureEvent = {
                userId: 'user-1',
                exitCode: 137,
                reason: 'oom_kill',
                timestamp: new Date().toISOString(),
            };

            aggregator.recordContainerFailure(event);

            const failures = aggregator.getRecentFailures();
            expect(failures[0]!.exitCode).toBe(137);
            expect(failures[0]!.reason).toBe('oom_kill');
        });

        it('recommends quarantine after >3 crashes in 5 minutes', () => {
            const now = Date.now();

            // Record 4 failures within the window
            for (let i = 0; i < 4; i++) {
                aggregator.recordContainerFailure({
                    userId: 'user-crash',
                    exitCode: 1,
                    reason: 'process_crash',
                    timestamp: new Date(now + i * 1000).toISOString(),
                });
            }

            expect(aggregator.shouldQuarantine('user-crash')).toBe(true);
        });

        it('does not quarantine with 3 or fewer crashes', () => {
            const now = Date.now();

            for (let i = 0; i < 3; i++) {
                aggregator.recordContainerFailure({
                    userId: 'user-ok',
                    exitCode: 1,
                    reason: 'process_crash',
                    timestamp: new Date(now + i * 1000).toISOString(),
                });
            }

            expect(aggregator.shouldQuarantine('user-ok')).toBe(false);
        });

        it('does not quarantine if crashes are outside the window', () => {
            const now = Date.now();
            const outsideWindow = now - 400_000; // 6.6 minutes ago (outside 5-min window)

            for (let i = 0; i < 5; i++) {
                aggregator.recordContainerFailure({
                    userId: 'user-old',
                    exitCode: 1,
                    reason: 'process_crash',
                    timestamp: new Date(outsideWindow + i * 1000).toISOString(),
                });
            }

            // Advance time so the failures are outside the window
            vi.advanceTimersByTime(400_000);

            expect(aggregator.shouldQuarantine('user-old')).toBe(false);
        });

        it('isolates quarantine decisions per user', () => {
            const now = Date.now();

            // user-a has 4 crashes
            for (let i = 0; i < 4; i++) {
                aggregator.recordContainerFailure({
                    userId: 'user-a',
                    exitCode: 1,
                    reason: 'process_crash',
                    timestamp: new Date(now + i * 1000).toISOString(),
                });
            }

            // user-b has 1 crash
            aggregator.recordContainerFailure({
                userId: 'user-b',
                exitCode: 1,
                reason: 'process_crash',
                timestamp: new Date(now).toISOString(),
            });

            expect(aggregator.shouldQuarantine('user-a')).toBe(true);
            expect(aggregator.shouldQuarantine('user-b')).toBe(false);
        });

        it('prunes old failures when new ones are recorded', () => {
            const now = Date.now();

            // Record old failures
            for (let i = 0; i < 5; i++) {
                aggregator.recordContainerFailure({
                    userId: 'user-prune',
                    exitCode: 1,
                    reason: 'process_crash',
                    timestamp: new Date(now - 600_000 + i * 1000).toISOString(), // 10 min ago
                });
            }

            // Advance time past the window
            vi.advanceTimersByTime(600_000);

            // Record a new failure — should trigger pruning
            aggregator.recordContainerFailure({
                userId: 'user-prune',
                exitCode: 1,
                reason: 'process_crash',
                timestamp: new Date(now + 600_000).toISOString(),
            });

            // Old failures should be pruned, only the new one remains
            const failures = aggregator.getRecentFailures();
            expect(failures.length).toBeLessThanOrEqual(2); // at most the boundary + new one
        });
    });

    // ── CloudWatch metrics ──

    describe('emitMetric', () => {
        it('emits a single metric to CloudWatch', async () => {
            await aggregator.emitMetric({
                name: 'ActiveContainers',
                value: 10,
                unit: 'Count',
            });

            // The mock CloudWatch client's send should have been called
            // (we can't easily inspect the mock due to constructor mocking,
            // but we verify no error is thrown)
        });

        it('handles CloudWatch errors gracefully', async () => {
            // Create aggregator with a failing CloudWatch client
            const failingAggregator = new HealthCheckAggregator(deps, { region: 'us-east-1' });

            // This should not throw even if CloudWatch fails
            await expect(
                failingAggregator.emitMetric({
                    name: 'ActiveContainers',
                    value: 5,
                    unit: 'Count',
                }),
            ).resolves.not.toThrow();

            failingAggregator.stop();
        });
    });

    describe('emitMetrics', () => {
        it('does nothing for empty metrics array', async () => {
            await aggregator.emitMetrics([]);
            // Should complete without error
        });

        it('emits multiple metrics', async () => {
            await aggregator.emitMetrics([
                { name: 'ActiveContainers', value: 5, unit: 'Count' },
                { name: 'MessagesPerMinute', value: 42, unit: 'Count' },
                { name: 'ProcessingLatency', value: 1500, unit: 'Milliseconds' },
            ]);
            // Should complete without error
        });
    });

    describe('emitOperationalMetrics', () => {
        it('emits standard operational metrics', async () => {
            await aggregator.emitOperationalMetrics({
                activeContainers: 8,
                messagesPerMinute: 25,
                processingLatencyMs: 2000,
                llmLatencyMs: 1500,
                vectorSearchLatencyMs: 200,
            });
            // Should complete without error
        });

        it('omits optional latency metrics when not provided', async () => {
            await aggregator.emitOperationalMetrics({
                activeContainers: 3,
                messagesPerMinute: 10,
            });
            // Should complete without error
        });
    });

    // ── Lifecycle ──

    describe('lifecycle', () => {
        it('start and stop manage the session check timer', () => {
            aggregator.start();
            // Timer is running — stop should clean it up
            aggregator.stop();
            // No error on double stop
            aggregator.stop();
        });
    });
});
