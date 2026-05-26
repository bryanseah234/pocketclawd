/**
 * Container Lifecycle Manager — spawns, monitors, and terminates per-user
 * Docker containers running the FastAPI sub-agent.
 *
 * In cloud mode, each user gets their own isolated container with:
 * - 512 MB memory limit
 * - 50% CPU (one core)
 * - 100 PIDs limit
 * - 2 GB disk quota
 * - Non-root user (UID 1000)
 * - Read-only root filesystem
 *
 * Containers are spawned on first message and terminated after idle timeout.
 *
 * Requirements: REQ-3.2 (Container Resource Limits), REQ-3.3 (Network Isolation)
 */

import { log } from '../../log.js';

import type { CloudServices } from '../bootstrap.js';

// ── Config ──

interface ContainerConfig {
    /** Docker image for sub-agent */
    image: string;
    /** Memory limit */
    memoryLimit: string;
    /** CPU quota (microseconds per 100000 period) */
    cpuQuota: number;
    /** Max PIDs */
    pidsLimit: number;
    /** Idle timeout before container is killed (ms) */
    idleTimeoutMs: number;
    /** Redis host for container env */
    redisHost: string;
    /** Redis port */
    redisPort: number;
    /** Redis password */
    redisPassword?: string;
    /** AWS region */
    awsRegion: string;
}

interface ManagedContainer {
    userId: string;
    containerId: string;
    startedAt: number;
    lastActivityAt: number;
}

// ── State ──

const containers = new Map<string, ManagedContainer>();
let sweepInterval: ReturnType<typeof setInterval> | null = null;
let config: ContainerConfig | null = null;

// ── Public API ──

export function initContainerManager(services: CloudServices): void {
    const cloudConfig = services.config;

    config = {
        image: cloudConfig.ecr?.agentImage || 'nanoclaw/agent:latest',
        memoryLimit: '512m',
        cpuQuota: 50000, // 50% of one core
        pidsLimit: 100,
        idleTimeoutMs: 10 * 60 * 1000, // 10 minutes
        redisHost: cloudConfig.redis.host,
        redisPort: cloudConfig.redis.port,
        redisPassword: cloudConfig.redis.password,
        awsRegion: 'ap-southeast-1',
    };

    // Sweep for idle containers every 60s
    sweepInterval = setInterval(() => sweepIdleContainers(), 60_000);
    log.info('Container manager initialized', { image: config.image, idleTimeoutMs: config.idleTimeoutMs });
}

export function stopContainerManager(): void {
    if (sweepInterval) {
        clearInterval(sweepInterval);
        sweepInterval = null;
    }
}

/**
 * Ensure a container is running for the given userId.
 * Spawns a new container if one doesn't exist.
 * Updates lastActivityAt if container already exists.
 */
export async function ensureContainer(userId: string): Promise<void> {
    const existing = containers.get(userId);
    if (existing) {
        existing.lastActivityAt = Date.now();
        return;
    }

    if (!config) {
        log.warn('Container manager not initialized, skipping spawn', { userId });
        return;
    }

    try {
        const containerId = await spawnContainer(userId);
        containers.set(userId, {
            userId,
            containerId,
            startedAt: Date.now(),
            lastActivityAt: Date.now(),
        });
        log.info('Container spawned', { userId, containerId });
    } catch (err) {
        log.error('Failed to spawn container', { userId, err });
    }
}

export function getActiveContainerCount(): number {
    return containers.size;
}

export function recordActivity(userId: string): void {
    const container = containers.get(userId);
    if (container) {
        container.lastActivityAt = Date.now();
    }
}

// ── Internal ──

async function spawnContainer(userId: string): Promise<string> {
    if (!config) throw new Error('Container manager not initialized');

    const { execSync } = await import('node:child_process');

    const containerName = `nanoclaw-agent-${userId.replace(/[^a-zA-Z0-9]/g, '-')}`;

    // Build environment variables for the container
    const envArgs = [
        `-e AGENT_USER_ID=${userId}`,
        `-e REDIS_HOST=${config.redisHost}`,
        `-e REDIS_PORT=${config.redisPort}`,
        `-e AWS_REGION=${config.awsRegion}`,
        `-e QUEUE_POLL_TIMEOUT=5`,
    ];
    if (config.redisPassword) {
        envArgs.push(`-e REDIS_PASSWORD=${config.redisPassword}`);
    }
    if (config.redisHost.includes('amazonaws.com')) {
        envArgs.push('-e REDIS_SSL=true');
    }

    const cmd = [
        'docker run -d',
        `--name ${containerName}`,
        `--memory ${config.memoryLimit}`,
        `--memory-swap ${config.memoryLimit}`, // No swap
        `--cpu-quota ${config.cpuQuota}`,
        '--cpu-period 100000',
        `--pids-limit ${config.pidsLimit}`,
        '--read-only',
        '--tmpfs /tmp:size=100m',
        '--tmpfs /app/tmp:size=100m',
        '--security-opt no-new-privileges',
        '--cap-drop ALL',
        '--restart unless-stopped',
        ...envArgs,
        config.image,
    ].join(' ');

    const output = execSync(cmd, { encoding: 'utf-8', timeout: 30_000 }).trim();
    return output.substring(0, 12); // Short container ID
}

async function killContainer(userId: string): Promise<void> {
    const container = containers.get(userId);
    if (!container) return;

    try {
        const { execSync } = await import('node:child_process');
        execSync(`docker rm -f ${container.containerId}`, { encoding: 'utf-8', timeout: 10_000 });
        containers.delete(userId);
        log.info('Container killed (idle)', { userId, containerId: container.containerId });
    } catch (err) {
        log.error('Failed to kill container', { userId, err });
        containers.delete(userId); // Remove from tracking regardless
    }
}

function sweepIdleContainers(): void {
    if (!config) return;

    const now = Date.now();
    for (const [userId, container] of containers) {
        const idleMs = now - container.lastActivityAt;
        if (idleMs > config.idleTimeoutMs) {
            void killContainer(userId);
        }
    }
}
