/**
 * Types for the health check and monitoring module.
 * Requirements: REQ-6.1, REQ-6.3
 */

// ── Component health status ──

export type ComponentStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface ComponentHealth {
    status: ComponentStatus;
    latencyMs?: number;
    message?: string;
    lastChecked: string; // ISO 8601
}

// ── Overall health response ──

export interface HealthResponse {
    status: ComponentStatus;
    timestamp: string; // ISO 8601
    uptime: number; // seconds
    components: {
        redis: ComponentHealth;
        dynamodb: ComponentHealth;
        opensearch: ComponentHealth;
        whatsappSession: ComponentHealth;
    };
    containers: {
        active: number;
        quarantined: number;
    };
}

// ── WhatsApp session health ──

export interface WhatsAppSessionHealth {
    valid: boolean;
    lastChecked: string; // ISO 8601
    expiresAt?: string; // ISO 8601, if known
    message?: string;
}

// ── Container monitoring ──

export interface ContainerFailureEvent {
    userId: string;
    exitCode: number | null;
    reason: 'oom_kill' | 'process_crash' | 'health_check_timeout' | 'disk_quota';
    timestamp: string; // ISO 8601
}

export interface ContainerMonitoringState {
    activeCount: number;
    quarantinedUsers: string[];
    recentFailures: ContainerFailureEvent[];
}

// ── CloudWatch custom metrics ──

export type MetricName =
    | 'ActiveContainers'
    | 'MessagesPerMinute'
    | 'ProcessingLatency'
    | 'LLMLatency'
    | 'VectorSearchLatency';

export interface CustomMetric {
    name: MetricName;
    value: number;
    unit: 'Count' | 'Milliseconds' | 'None';
    timestamp?: string; // ISO 8601
    dimensions?: Record<string, string>;
}

// ── Health check configuration ──

export interface HealthCheckConfig {
    /** AWS region (defaults to ap-southeast-1) */
    region?: string;
    /** CloudWatch metrics namespace */
    metricsNamespace?: string;
    /** WhatsApp session health check interval in ms (defaults to 3600000 = 1 hour) */
    sessionCheckIntervalMs?: number;
    /** Container crash window for quarantine detection in ms (defaults to 300000 = 5 min) */
    crashWindowMs?: number;
    /** Max crashes before quarantine (defaults to 3) */
    maxCrashesBeforeQuarantine?: number;
}

// ── Dependencies interface (for dependency injection) ──

export interface HealthDependencies {
    /** Check Redis connectivity — returns true if PING succeeds */
    checkRedis: () => Promise<boolean>;
    /** Check DynamoDB reachability — returns true if DescribeTable succeeds */
    checkDynamoDB: () => Promise<boolean>;
    /** Check OpenSearch status — returns true if cluster health is green/yellow */
    checkOpenSearch: () => Promise<boolean>;
    /** Check WhatsApp session validity — returns session health info */
    checkWhatsAppSession: () => Promise<WhatsAppSessionHealth>;
    /** Get active container count */
    getActiveContainerCount: () => number;
    /** Get quarantined user count */
    getQuarantinedCount: () => number;
    /** Send admin alert (e.g., via CloudWatch alarm or direct notification) */
    sendAdminAlert: (message: string, severity: 'warning' | 'critical') => Promise<void>;
}
