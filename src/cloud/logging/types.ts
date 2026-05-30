/**
 * TypeScript interfaces for CloudWatch structured logging.
 * Requirements: REQ-6.1, REQ-6.2
 */

export type LogLevel = 'INFO' | 'WARNING' | 'ERROR';

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
    userId?: string;
    context?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface MetricUnit {
    name: string;
    value: number;
    unit: 'Count' | 'Milliseconds' | 'Bytes' | 'Percent' | 'None';
    dimensions?: Record<string, string>;
}

export interface CloudWatchLoggerConfig {
    /** AWS region (defaults to ap-southeast-1) */
    region?: string;
    /** Log group prefix (defaults to 'nanoclaw/app') */
    logGroupPrefix?: string;
    /** CloudWatch Metrics namespace */
    metricsNamespace?: string;
    /** Flush interval in milliseconds (defaults to 5000) */
    flushIntervalMs?: number;
    /** Max buffer size before forced flush (defaults to 100) */
    maxBufferSize?: number;
    /** Whether to enable local console output alongside CloudWatch */
    localFallback?: boolean;
}

export interface BufferedLogEntry {
    logGroupName: string;
    entry: LogEntry;
}

export const LOG_GROUP_NAMES: Record<LogLevel, string> = {
    INFO: 'nanoclaw/app/info',
    WARNING: 'nanoclaw/app/warning',
    ERROR: 'nanoclaw/app/error',
};

export const METRICS_NAMESPACE = 'NanoClaw/Application';

/** Pre-defined metric names */
export const METRIC_NAMES = {
    ErrorCount: 'ErrorCount',
    MessageProcessingTime: 'MessageProcessingTime',
    ActiveContainers: 'ActiveContainers',
    // t5-30: operational alarms
    QueueDepth: 'QueueDepth',
    OrchestratorRestart: 'OrchestratorRestart',
} as const;
