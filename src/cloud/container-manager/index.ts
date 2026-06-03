/**
 * Cloud Container Manager
 * Manages per-user Docker containers for NanoClaw cloud deployment.
 *
 * Responsibilities:
 * - Pull agent images from ECR with automatic auth token refresh (12h expiry)
 * - Spawn containers with strict resource limits (REQ-1.2)
 * - Monitor container health with automatic restart on failure (REQ-6.3)
 * - Quarantine users with repeated crashes (>3 in 5min)
 *
 * Requirements: REQ-1.2, REQ-6.3
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';

import { log } from '../../log.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';

import type {
    ContainerConfig,
    ContainerInfo,
    ContainerManagerConfig,
    ContainerStatus,
    EcrAuthToken,
    FailureRecord,
    HealthCheckResult,
} from './types.js';

export type { ContainerConfig, ContainerInfo, ContainerManagerConfig, ContainerStatus, EcrAuthToken, FailureRecord, HealthCheckResult } from './types.js';

// ── Default configuration ──

const DEFAULT_CONFIG: ContainerManagerConfig = {
    region: 'ap-southeast-1',
    ecrRegistryUri: '',
    agentImageRepo: 'nanoclaw/agent',
    imageTag: 'latest',
    managementNetwork: '172.20.0.0/16',
    subnetPrefix: '172.20',
    healthCheckIntervalMs: 30_000,
    maxFailuresBeforeQuarantine: 3,
    quarantineWindowMs: 300_000, // 5 minutes
    seccompProfile: 'runtime/default',
    dockerNetworkName: 'nanoclaw-mgmt',
};

// ── ECR Authentication ──

/**
 * Manages ECR authentication tokens with automatic refresh.
 * ECR tokens expire every 12 hours.
 */
export class EcrAuthManager {
    private token: EcrAuthToken | null = null;
    private readonly region: string;
    private readonly registryUri: string;

    /** Buffer before expiry to trigger refresh (30 minutes) */
    private static readonly REFRESH_BUFFER_MS = 30 * 60 * 1000;

    constructor(region: string, registryUri: string) {
        this.region = region;
        this.registryUri = registryUri;
    }

    /**
     * Get a valid ECR auth token, refreshing if expired or about to expire.
     */
    async getToken(): Promise<EcrAuthToken> {
        if (this.token && !this.isTokenExpiring()) {
            return this.token;
        }
        return this.refreshToken();
    }

    /**
     * Check if the current token is expired or about to expire.
     */
    isTokenExpiring(): boolean {
        if (!this.token) return true;
        const now = Date.now();
        const expiresAt = this.token.expiresAt.getTime();
        return now >= expiresAt - EcrAuthManager.REFRESH_BUFFER_MS;
    }

    /**
     * Refresh the ECR auth token using the AWS CLI.
     * In production, this uses the EC2 instance's IAM role.
     */
    async refreshToken(): Promise<EcrAuthToken> {
        log.info('Refreshing ECR auth token', { region: this.region });

        try {
            // argv form: region is config-derived, but no shell avoids any
            // interpolation risk and keeps this consistent with the login call.
            const getPw = spawnSync(
                'aws',
                ['ecr', 'get-login-password', '--region', this.region],
                { encoding: 'utf-8', timeout: 30_000 },
            );
            if (getPw.status !== 0) {
                throw new Error(`ecr get-login-password failed (exit ${getPw.status}): ${(getPw.stderr || '').trim()}`);
            }

            const password = (getPw.stdout || '').trim();

            // Docker login with the ECR token. The password is fed via stdin
            // (input) rather than echoed onto the command line, so it never
            // appears in the process table / shell history and there is no
            // shell to interpret it. --password-stdin reads it from fd 0.
            const login = spawnSync(
                CONTAINER_RUNTIME_BIN,
                ['login', '--username', 'AWS', '--password-stdin', this.registryUri],
                { input: password, encoding: 'utf-8', timeout: 30_000 },
            );
            if (login.status !== 0) {
                throw new Error(`${CONTAINER_RUNTIME_BIN} login failed (exit ${login.status}): ${(login.stderr || '').trim()}`);
            }

            // ECR tokens are valid for 12 hours
            const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

            this.token = {
                token: password,
                expiresAt,
                proxyEndpoint: this.registryUri,
            };

            log.info('ECR auth token refreshed', { expiresAt: expiresAt.toISOString() });
            return this.token;
        } catch (err) {
            log.error('Failed to refresh ECR auth token', { err });
            throw new Error('ECR authentication failed', { cause: err });
        }
    }
}

// ── Container Manager ──

export class CloudContainerManager {
    private readonly config: ContainerManagerConfig;
    private readonly ecrAuth: EcrAuthManager;
    private readonly containers = new Map<string, ContainerInfo>();
    private readonly processes = new Map<string, ChildProcess>();
    private readonly failureHistory = new Map<string, FailureRecord[]>();
    private readonly quarantinedUsers = new Set<string>();
    private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
    private subnetCounter = 1;

    constructor(config: Partial<ContainerManagerConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.ecrAuth = new EcrAuthManager(this.config.region, this.config.ecrRegistryUri);
    }

    // ── Public API ──

    /**
     * Initialize the container manager: ensure Docker network exists, pull latest image.
     */
    async initialize(): Promise<void> {
        this.ensureManagementNetwork();
        await this.pullAgentImage();
        this.startHealthMonitoring();
        log.info('Cloud container manager initialized', {
            network: this.config.dockerNetworkName,
            image: this.getImageUri(),
        });
    }

    /**
     * Spawn a container for a user.
     * Returns container info on success.
     * Throws if user is quarantined or spawn fails.
     */
    async spawn(userId: string): Promise<ContainerInfo> {
        if (this.quarantinedUsers.has(userId)) {
            throw new Error(`User ${userId} is quarantined due to repeated container failures`);
        }

        if (this.containers.has(userId)) {
            const existing = this.containers.get(userId)!;
            if (existing.status === 'running') {
                return existing;
            }
        }

        // Ensure we have a fresh image
        await this.ecrAuth.getToken();

        const containerName = `nanoclaw-agent-${userId}-${Date.now()}`;
        const subnet = this.allocateSubnet(userId);
        const containerConfig = this.buildContainerConfig(subnet);
        const args = this.buildDockerArgs(containerName, userId, containerConfig, subnet);

        log.info('Spawning cloud container', { userId, containerName, subnet });

        const process = spawn(CONTAINER_RUNTIME_BIN, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const info: ContainerInfo = {
            userId,
            containerId: '', // Will be populated after start
            containerName,
            status: 'starting',
            startedAt: new Date(),
            failureCount: 0,
            subnet,
        };

        this.containers.set(userId, info);
        this.processes.set(userId, process);

        // Capture container ID from stdout (docker run prints it)
        let stdoutBuffer = '';
        process.stdout?.on('data', (data: Buffer) => {
            stdoutBuffer += data.toString();
        });

        process.stderr?.on('data', (data: Buffer) => {
            const line = data.toString().trim();
            if (line) log.debug(`[container:${userId}] ${line}`);
        });

        process.on('close', (code) => {
            this.handleContainerExit(userId, code);
        });

        process.on('error', (err) => {
            log.error('Container spawn error', { userId, err });
            this.handleContainerExit(userId, null);
        });

        // Wait briefly for container to start
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Update container ID
        info.containerId = stdoutBuffer.trim().slice(0, 12) || containerName;
        info.status = 'running';

        log.info('Container spawned', { userId, containerName, containerId: info.containerId });
        return info;
    }

    /**
     * Kill a container for a user.
     */
    async kill(userId: string): Promise<void> {
        const info = this.containers.get(userId);
        if (!info) return;

        log.info('Killing container', { userId, containerName: info.containerName });

        try {
            spawnSync(
                CONTAINER_RUNTIME_BIN,
                ['stop', '-t', '5', info.containerName],
                { stdio: 'pipe', timeout: 15_000 },
            );
        } catch {
            // Force kill if graceful stop fails
            try {
                spawnSync(
                    CONTAINER_RUNTIME_BIN,
                    ['kill', info.containerName],
                    { stdio: 'pipe', timeout: 5_000 },
                );
            } catch {
                // Container may already be gone
            }
        }

        const proc = this.processes.get(userId);
        if (proc && !proc.killed) {
            proc.kill('SIGKILL');
        }

        this.containers.delete(userId);
        this.processes.delete(userId);
    }

    /**
     * Get the status of a user's container.
     */
    getStatus(userId: string): ContainerStatus {
        if (this.quarantinedUsers.has(userId)) return 'quarantined';
        const info = this.containers.get(userId);
        return info?.status ?? 'stopped';
    }

    /**
     * List all active containers.
     */
    listActive(): ContainerInfo[] {
        return Array.from(this.containers.values()).filter(
            (c) => c.status === 'running' || c.status === 'starting',
        );
    }

    /**
     * Check if a user is quarantined.
     */
    isQuarantined(userId: string): boolean {
        return this.quarantinedUsers.has(userId);
    }

    /**
     * Remove a user from quarantine (admin action).
     */
    unquarantine(userId: string): void {
        this.quarantinedUsers.delete(userId);
        this.failureHistory.delete(userId);
        log.info('User unquarantined', { userId });
    }

    /**
     * Stop health monitoring and clean up.
     */
    shutdown(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }

    /**
     * Get the number of active containers.
     */
    getActiveCount(): number {
        return this.listActive().length;
    }

    // ── Private: ECR Image Management ──

    private getImageUri(): string {
        const { ecrRegistryUri, agentImageRepo, imageTag } = this.config;
        return `${ecrRegistryUri}/${agentImageRepo}:${imageTag}`;
    }

    /**
     * Pull the latest agent image from ECR.
     */
    async pullAgentImage(): Promise<void> {
        await this.ecrAuth.getToken();
        const imageUri = this.getImageUri();

        log.info('Pulling agent image from ECR', { imageUri });

        try {
            spawnSync(
                CONTAINER_RUNTIME_BIN,
                ['pull', imageUri],
                { stdio: 'pipe', timeout: 300_000 }, // 5 min timeout for pull
            );
            log.info('Agent image pulled', { imageUri });
        } catch (err) {
            log.error('Failed to pull agent image', { imageUri, err });
            throw new Error(`Failed to pull image ${imageUri}`, { cause: err });
        }
    }

    // ── Private: Docker Network ──

    /**
     * Ensure the management Docker network exists.
     * Creates it with the configured subnet if missing.
     */
    private ensureManagementNetwork(): void {
        const { dockerNetworkName, managementNetwork } = this.config;

        try {
            spawnSync(
                CONTAINER_RUNTIME_BIN,
                ['network', 'inspect', dockerNetworkName],
                { stdio: 'pipe' },
            );
            log.debug('Management network exists', { network: dockerNetworkName });
        } catch {
            log.info('Creating management network', { network: dockerNetworkName, subnet: managementNetwork });
            spawnSync(
                CONTAINER_RUNTIME_BIN,
                ['network', 'create', '--driver', 'bridge', '--subnet', managementNetwork, dockerNetworkName],
                { stdio: 'pipe' },
            );
        }
    }

    /**
     * Allocate a per-user subnet within the management network.
     * Uses incrementing third octet: 172.20.1.0/24, 172.20.2.0/24, etc.
     */
    private allocateSubnet(userId: string): string {
        // Check if user already has an allocated subnet
        const existing = this.containers.get(userId);
        if (existing?.subnet) return existing.subnet;

        const octet = this.subnetCounter++;
        if (octet > 254) {
            throw new Error('Subnet pool exhausted');
        }
        return `${this.config.subnetPrefix}.${octet}.0/24`;
    }

    // ── Private: Container Configuration ──

    private buildContainerConfig(subnet: string): ContainerConfig {
        return {
            memoryLimit: '512m',
            cpuQuota: 50_000,
            pidsLimit: 100,
            diskQuota: '2g',
            readOnlyRootfs: true,
            dropCapabilities: 'ALL',
            seccompProfile: this.config.seccompProfile,
            networkNamespace: subnet,
            uid: 1000,
        };
    }

    /**
     * Build Docker CLI arguments for spawning a container with full security constraints.
     */
    private buildDockerArgs(
        containerName: string,
        userId: string,
        config: ContainerConfig,
        _subnet: string,
    ): string[] {
        const args: string[] = [
            'run',
            '--rm',
            '--name', containerName,

            // ── Resource limits (REQ-1.2) ──
            '--memory', config.memoryLimit,
            '--memory-swap', config.memoryLimit, // No swap (memory == memory-swap)
            '--cpu-quota', String(config.cpuQuota),
            '--cpu-period', '100000', // Default 100ms period, quota=50000 → 50% CPU
            '--pids-limit', String(config.pidsLimit),

            // Disk quota via tmpfs for writable areas (read-only rootfs)
            '--tmpfs', `/tmp:rw,noexec,nosuid,size=${config.diskQuota}`,

            // ── Security hardening (REQ-1.2) ──
            '--read-only',
            '--cap-drop', config.dropCapabilities,
            '--security-opt', `seccomp=${config.seccompProfile}`,
            '--security-opt', 'no-new-privileges',
            '--user', `${config.uid}:${config.uid}`,

            // ── Networking ──
            '--network', this.config.dockerNetworkName,

            // ── Labels for management ──
            '--label', `nanoclaw.userId=${userId}`,
            '--label', 'nanoclaw.managed=cloud',

            // ── Environment ──
            '-e', `NANOCLAW_USER_ID=${userId}`,
            '-e', 'NANOCLAW_ENV=cloud',

            // ── Image ──
            this.getImageUri(),
        ];

        return args;
    }

    // ── Private: Health Monitoring ──

    /**
     * Start periodic health checks for all running containers.
     */
    private startHealthMonitoring(): void {
        if (this.healthCheckTimer) return;

        this.healthCheckTimer = setInterval(() => {
            this.runHealthChecks();
        }, this.config.healthCheckIntervalMs);
    }

    /**
     * Run health checks on all active containers.
     */
    private runHealthChecks(): void {
        for (const [userId, info] of this.containers) {
            if (info.status !== 'running') continue;

            const result = this.checkContainerHealth(userId, info);
            info.lastHealthCheck = new Date();

            if (!result.healthy) {
                log.warn('Container health check failed', { userId, error: result.error });
                this.handleUnhealthyContainer(userId, result);
            }
        }
    }

    /**
     * Check if a container is healthy by inspecting its state.
     */
    private checkContainerHealth(userId: string, info: ContainerInfo): HealthCheckResult {
        try {
            const inspect = spawnSync(
                CONTAINER_RUNTIME_BIN,
                ['inspect', '--format', '{{.State.Running}}', info.containerName],
                { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5_000 },
            );
            if (inspect.status !== 0) {
                throw new Error(`inspect failed (exit ${inspect.status})`);
            }
            const output = inspect.stdout || '';

            const isRunning = output.trim() === 'true';
            return {
                healthy: isRunning,
                containerId: info.containerId,
                userId,
                error: isRunning ? undefined : 'Container not running',
            };
        } catch (err) {
            return {
                healthy: false,
                containerId: info.containerId,
                userId,
                error: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    /**
     * Handle an unhealthy container — attempt restart with backoff.
     */
    private handleUnhealthyContainer(userId: string, _result: HealthCheckResult): void {
        const info = this.containers.get(userId);
        if (!info) return;

        info.failureCount++;
        this.recordFailure(userId, null, 'health_check_timeout');

        if (this.shouldQuarantine(userId)) {
            this.quarantineUser(userId);
        } else {
            this.scheduleRestart(userId);
        }
    }

    // ── Private: Failure Recovery ──

    /**
     * Handle container exit. Determines recovery action based on exit code.
     *
     * Exit codes:
     * - 0: Normal exit, no restart needed
     * - 137: OOM kill (SIGKILL from kernel) → log, alert, respawn
     * - Other non-zero: Process crash → increment counter, respawn with backoff
     */
    private handleContainerExit(userId: string, exitCode: number | null): void {
        const info = this.containers.get(userId);
        if (!info) return;

        info.status = 'stopped';
        this.processes.delete(userId);

        // Normal exit — no recovery needed
        if (exitCode === 0) {
            log.info('Container exited normally', { userId, exitCode });
            this.containers.delete(userId);
            return;
        }

        // OOM kill (exit 137)
        if (exitCode === 137) {
            log.error('Container OOM killed', { userId, exitCode });
            this.recordFailure(userId, exitCode, 'oom_kill');
        } else {
            log.warn('Container crashed', { userId, exitCode });
            this.recordFailure(userId, exitCode, 'process_crash');
        }

        info.failureCount++;

        // Check quarantine threshold
        if (this.shouldQuarantine(userId)) {
            this.quarantineUser(userId);
        } else {
            this.scheduleRestart(userId);
        }
    }

    /**
     * Record a failure event for a user.
     */
    private recordFailure(userId: string, exitCode: number | null, reason: string): void {
        const history = this.failureHistory.get(userId) ?? [];
        history.push({
            timestamp: new Date(),
            exitCode,
            reason,
        });
        this.failureHistory.set(userId, history);
    }

    /**
     * Check if a user should be quarantined based on failure history.
     * Quarantine if >3 failures within the quarantine window (5 minutes).
     */
    shouldQuarantine(userId: string): boolean {
        const history = this.failureHistory.get(userId) ?? [];
        const windowStart = Date.now() - this.config.quarantineWindowMs;

        const recentFailures = history.filter(
            (f) => f.timestamp.getTime() >= windowStart,
        );

        return recentFailures.length > this.config.maxFailuresBeforeQuarantine;
    }

    /**
     * Quarantine a user — stop respawning, alert admin.
     */
    private quarantineUser(userId: string): void {
        this.quarantinedUsers.add(userId);
        const info = this.containers.get(userId);

        log.error('User quarantined due to repeated container failures', {
            userId,
            failureCount: info?.failureCount ?? 0,
            recentFailures: this.failureHistory.get(userId)?.slice(-5),
        });

        // Clean up container state
        this.containers.delete(userId);
        this.processes.delete(userId);
    }

    /**
     * Schedule a container restart with exponential backoff.
     * Backoff: 2^(failureCount-1) seconds, capped at 60s.
     */
    private scheduleRestart(userId: string): void {
        const info = this.containers.get(userId);
        if (!info) return;

        const backoffMs = Math.min(
            Math.pow(2, info.failureCount - 1) * 1000,
            60_000,
        );

        info.status = 'restarting';
        log.info('Scheduling container restart', { userId, backoffMs, failureCount: info.failureCount });

        setTimeout(async () => {
            try {
                // Remove old entry before respawning
                this.containers.delete(userId);
                this.processes.delete(userId);
                await this.spawn(userId);
            } catch (err) {
                log.error('Container restart failed', { userId, err });
            }
        }, backoffMs);
    }

    // ── Testing helpers (package-internal) ──

    /** Exposed for testing: get failure history for a user. */
    getFailureHistory(userId: string): FailureRecord[] {
        return this.failureHistory.get(userId) ?? [];
    }

    /** Exposed for testing: get the ECR auth manager. */
    getEcrAuth(): EcrAuthManager {
        return this.ecrAuth;
    }
}
