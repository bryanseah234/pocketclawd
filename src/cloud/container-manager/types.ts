/**
 * Types for the cloud container manager.
 * Requirements: REQ-1.2, REQ-6.3
 */

export interface ContainerConfig {
    memoryLimit: '512m';
    cpuQuota: 50000; // 50% single core (Docker --cpu-quota in microseconds per 100ms period)
    pidsLimit: 100;
    diskQuota: '2g';
    readOnlyRootfs: true;
    dropCapabilities: 'ALL';
    seccompProfile: string;
    networkNamespace: string;
    uid: 1000;
}

export interface ContainerInfo {
    userId: string;
    containerId: string;
    containerName: string;
    status: ContainerStatus;
    startedAt: Date;
    lastHealthCheck?: Date;
    failureCount: number;
    subnet: string;
}

export type ContainerStatus = 'running' | 'stopped' | 'starting' | 'quarantined' | 'restarting';

export interface ContainerManagerConfig {
    /** AWS region for ECR */
    region: string;
    /** ECR registry URI (e.g. 123456789.dkr.ecr.ap-southeast-1.amazonaws.com) */
    ecrRegistryUri: string;
    /** Agent image repository name in ECR */
    agentImageRepo: string;
    /** Image tag to pull (default: 'latest') */
    imageTag: string;
    /** Management network CIDR */
    managementNetwork: string;
    /** Per-user subnet prefix (e.g. '172.20') */
    subnetPrefix: string;
    /** Health check interval in ms (default: 30000) */
    healthCheckIntervalMs: number;
    /** Max failures before quarantine (default: 3) */
    maxFailuresBeforeQuarantine: number;
    /** Quarantine window in ms (default: 300000 = 5 min) */
    quarantineWindowMs: number;
    /** Seccomp profile path */
    seccompProfile: string;
    /** Docker network name for management */
    dockerNetworkName: string;
}

export interface EcrAuthToken {
    token: string;
    expiresAt: Date;
    proxyEndpoint: string;
}

export interface FailureRecord {
    timestamp: Date;
    exitCode: number | null;
    reason: string;
}

export interface HealthCheckResult {
    healthy: boolean;
    containerId: string;
    userId: string;
    responseTimeMs?: number;
    error?: string;
}
