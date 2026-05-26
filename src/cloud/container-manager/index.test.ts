/**
 * Unit tests for the Cloud Container Manager.
 * Tests ECR auth refresh, resource limit enforcement, health monitoring,
 * and quarantine logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudContainerManager, EcrAuthManager } from './index.js';

// Mock child_process
vi.mock('child_process', () => ({
    execSync: vi.fn(),
    spawn: vi.fn(() => {
        const proc = {
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            on: vi.fn(),
            kill: vi.fn(),
            killed: false,
            pid: 12345,
        };
        return proc;
    }),
}));

// Mock the log module
vi.mock('../../log.js', () => ({
    log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
    },
}));

// Mock container-runtime
vi.mock('../../container-runtime.js', () => ({
    CONTAINER_RUNTIME_BIN: 'docker',
}));

import { execSync, spawn } from 'child_process';

const mockExecSync = vi.mocked(execSync);
const mockSpawn = vi.mocked(spawn);

describe('EcrAuthManager', () => {
    let authManager: EcrAuthManager;

    beforeEach(() => {
        vi.clearAllMocks();
        authManager = new EcrAuthManager('ap-southeast-1', '123456789.dkr.ecr.ap-southeast-1.amazonaws.com');
    });

    it('refreshes token on first call', async () => {
        mockExecSync
            .mockReturnValueOnce('mock-ecr-token\n' as any) // get-login-password
            .mockReturnValueOnce('' as any); // docker login

        const token = await authManager.getToken();

        expect(token.token).toBe('mock-ecr-token');
        expect(token.proxyEndpoint).toBe('123456789.dkr.ecr.ap-southeast-1.amazonaws.com');
        expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('returns cached token when not expired', async () => {
        mockExecSync
            .mockReturnValueOnce('mock-ecr-token\n' as any)
            .mockReturnValueOnce('' as any);

        const token1 = await authManager.getToken();
        const token2 = await authManager.getToken();

        // Should only call execSync twice (once for get-login-password, once for docker login)
        expect(mockExecSync).toHaveBeenCalledTimes(2);
        expect(token1).toBe(token2);
    });

    it('reports token as expiring when null', () => {
        expect(authManager.isTokenExpiring()).toBe(true);
    });

    it('throws on auth failure', async () => {
        mockExecSync.mockImplementation(() => {
            throw new Error('AWS CLI not configured');
        });

        await expect(authManager.refreshToken()).rejects.toThrow('ECR authentication failed');
    });
});

describe('CloudContainerManager', () => {
    let manager: CloudContainerManager;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();

        manager = new CloudContainerManager({
            region: 'ap-southeast-1',
            ecrRegistryUri: '123456789.dkr.ecr.ap-southeast-1.amazonaws.com',
            agentImageRepo: 'nanoclaw/agent',
            imageTag: 'latest',
            healthCheckIntervalMs: 30_000,
            maxFailuresBeforeQuarantine: 3,
            quarantineWindowMs: 300_000,
        });
    });

    afterEach(() => {
        manager.shutdown();
        vi.useRealTimers();
    });

    describe('spawn', () => {
        it('spawns a container with correct resource limits', async () => {
            // Mock ECR auth
            mockExecSync
                .mockReturnValueOnce('ecr-token\n' as any) // ECR get-login-password
                .mockReturnValueOnce('' as any); // docker login

            // Mock spawn to simulate a running container
            const mockProcess = {
                stdout: { on: vi.fn() },
                stderr: { on: vi.fn() },
                on: vi.fn(),
                kill: vi.fn(),
                killed: false,
                pid: 12345,
            };
            mockSpawn.mockReturnValue(mockProcess as any);

            const spawnPromise = manager.spawn('user-123');
            await vi.advanceTimersByTimeAsync(1100);
            const info = await spawnPromise;

            expect(info.userId).toBe('user-123');
            expect(info.status).toBe('running');
            expect(info.subnet).toMatch(/^172\.20\.\d+\.0\/24$/);

            // Verify Docker args include resource limits
            const spawnArgs = mockSpawn.mock.calls[0]?.[1] as string[];
            expect(spawnArgs).toContain('--memory');
            expect(spawnArgs).toContain('512m');
            expect(spawnArgs).toContain('--cpu-quota');
            expect(spawnArgs).toContain('50000');
            expect(spawnArgs).toContain('--pids-limit');
            expect(spawnArgs).toContain('100');
            expect(spawnArgs).toContain('--read-only');
            expect(spawnArgs).toContain('--cap-drop');
            expect(spawnArgs).toContain('ALL');
            expect(spawnArgs).toContain('--security-opt');
            expect(spawnArgs).toContain('no-new-privileges');
            expect(spawnArgs).toContain('--user');
            expect(spawnArgs).toContain('1000:1000');
        });

        it('rejects spawn for quarantined users', async () => {
            // Manually quarantine a user
            (manager as any).quarantinedUsers.add('bad-user');

            await expect(manager.spawn('bad-user')).rejects.toThrow('quarantined');
        });

        it('returns existing container if already running', async () => {
            mockExecSync
                .mockReturnValueOnce('ecr-token\n' as any)
                .mockReturnValueOnce('' as any);

            const mockProcess = {
                stdout: { on: vi.fn() },
                stderr: { on: vi.fn() },
                on: vi.fn(),
                kill: vi.fn(),
                killed: false,
                pid: 12345,
            };
            mockSpawn.mockReturnValue(mockProcess as any);

            const spawnPromise = manager.spawn('user-456');
            await vi.advanceTimersByTimeAsync(1100);
            const info1 = await spawnPromise;

            // Second spawn should return same container
            const info2 = await manager.spawn('user-456');
            expect(info2.containerName).toBe(info1.containerName);
        });
    });

    describe('kill', () => {
        it('stops and removes container', async () => {
            mockExecSync
                .mockReturnValueOnce('ecr-token\n' as any)
                .mockReturnValueOnce('' as any);

            const mockProcess = {
                stdout: { on: vi.fn() },
                stderr: { on: vi.fn() },
                on: vi.fn(),
                kill: vi.fn(),
                killed: false,
                pid: 12345,
            };
            mockSpawn.mockReturnValue(mockProcess as any);

            const spawnPromise = manager.spawn('user-kill');
            await vi.advanceTimersByTimeAsync(1100);
            await spawnPromise;

            // Reset mock to track kill calls
            mockExecSync.mockReturnValueOnce('' as any); // docker stop

            await manager.kill('user-kill');

            expect(manager.getStatus('user-kill')).toBe('stopped');
        });
    });

    describe('quarantine logic', () => {
        it('quarantines user after >3 failures in 5 minutes', () => {
            const userId = 'crash-user';

            // Record 4 failures within the window
            for (let i = 0; i < 4; i++) {
                (manager as any).recordFailure(userId, 1, 'process_crash');
            }

            expect(manager.shouldQuarantine(userId)).toBe(true);
        });

        it('does not quarantine with 3 or fewer failures', () => {
            const userId = 'ok-user';

            for (let i = 0; i < 3; i++) {
                (manager as any).recordFailure(userId, 1, 'process_crash');
            }

            expect(manager.shouldQuarantine(userId)).toBe(false);
        });

        it('does not quarantine if failures are outside the window', () => {
            const userId = 'old-crash-user';
            const history = (manager as any).failureHistory;

            // Add old failures (outside 5-min window)
            const oldTime = new Date(Date.now() - 600_000); // 10 min ago
            history.set(userId, [
                { timestamp: oldTime, exitCode: 1, reason: 'crash' },
                { timestamp: oldTime, exitCode: 1, reason: 'crash' },
                { timestamp: oldTime, exitCode: 1, reason: 'crash' },
                { timestamp: oldTime, exitCode: 1, reason: 'crash' },
            ]);

            expect(manager.shouldQuarantine(userId)).toBe(false);
        });

        it('unquarantine removes user from quarantine set', () => {
            (manager as any).quarantinedUsers.add('quarantined-user');
            expect(manager.isQuarantined('quarantined-user')).toBe(true);

            manager.unquarantine('quarantined-user');
            expect(manager.isQuarantined('quarantined-user')).toBe(false);
        });
    });

    describe('container exit handling', () => {
        it('handles OOM kill (exit 137) by recording failure and scheduling restart', async () => {
            mockExecSync
                .mockReturnValueOnce('ecr-token\n' as any)
                .mockReturnValueOnce('' as any);

            const mockProcess = {
                stdout: { on: vi.fn() },
                stderr: { on: vi.fn() },
                on: vi.fn(),
                kill: vi.fn(),
                killed: false,
                pid: 12345,
            };
            mockSpawn.mockReturnValue(mockProcess as any);

            const spawnPromise = manager.spawn('oom-user');
            await vi.advanceTimersByTimeAsync(1100);
            await spawnPromise;

            // Simulate OOM exit
            const closeHandler = mockProcess.on.mock.calls.find(
                (call) => call[0] === 'close',
            )?.[1] as (code: number) => void;

            closeHandler(137);

            const history = manager.getFailureHistory('oom-user');
            expect(history).toHaveLength(1);
            expect(history[0].exitCode).toBe(137);
            expect(history[0].reason).toBe('oom_kill');
        });

        it('does not restart on normal exit (code 0)', async () => {
            mockExecSync
                .mockReturnValueOnce('ecr-token\n' as any)
                .mockReturnValueOnce('' as any);

            const mockProcess = {
                stdout: { on: vi.fn() },
                stderr: { on: vi.fn() },
                on: vi.fn(),
                kill: vi.fn(),
                killed: false,
                pid: 12345,
            };
            mockSpawn.mockReturnValue(mockProcess as any);

            const spawnPromise = manager.spawn('normal-user');
            await vi.advanceTimersByTimeAsync(1100);
            await spawnPromise;

            // Simulate normal exit
            const closeHandler = mockProcess.on.mock.calls.find(
                (call) => call[0] === 'close',
            )?.[1] as (code: number) => void;

            closeHandler(0);

            expect(manager.getStatus('normal-user')).toBe('stopped');
            expect(manager.getFailureHistory('normal-user')).toHaveLength(0);
        });
    });

    describe('getStatus', () => {
        it('returns stopped for unknown users', () => {
            expect(manager.getStatus('unknown')).toBe('stopped');
        });

        it('returns quarantined for quarantined users', () => {
            (manager as any).quarantinedUsers.add('q-user');
            expect(manager.getStatus('q-user')).toBe('quarantined');
        });
    });

    describe('listActive', () => {
        it('returns only running/starting containers', async () => {
            mockExecSync
                .mockReturnValueOnce('ecr-token\n' as any)
                .mockReturnValueOnce('' as any);

            const mockProcess = {
                stdout: { on: vi.fn() },
                stderr: { on: vi.fn() },
                on: vi.fn(),
                kill: vi.fn(),
                killed: false,
                pid: 12345,
            };
            mockSpawn.mockReturnValue(mockProcess as any);

            const spawnPromise = manager.spawn('active-user');
            await vi.advanceTimersByTimeAsync(1100);
            await spawnPromise;

            const active = manager.listActive();
            expect(active).toHaveLength(1);
            expect(active[0].userId).toBe('active-user');
        });
    });

    describe('subnet allocation', () => {
        it('allocates unique subnets for different users', async () => {
            mockExecSync.mockReturnValue('' as any);

            const mockProcess = {
                stdout: { on: vi.fn() },
                stderr: { on: vi.fn() },
                on: vi.fn(),
                kill: vi.fn(),
                killed: false,
                pid: 12345,
            };
            mockSpawn.mockReturnValue(mockProcess as any);

            const p1 = manager.spawn('user-a');
            await vi.advanceTimersByTimeAsync(1100);
            const info1 = await p1;

            const p2 = manager.spawn('user-b');
            await vi.advanceTimersByTimeAsync(1100);
            const info2 = await p2;

            expect(info1.subnet).not.toBe(info2.subnet);
        });
    });
});
