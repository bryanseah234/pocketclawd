/**
 * CloudWatch structured logger with sensitive data redaction.
 * Requirements: REQ-6.1, REQ-6.2
 *
 * Implements:
 * - Structured JSON log entries for CloudWatch Logs
 * - Sensitive data redaction (API keys, tokens, passwords, message content)
 * - Custom metric emission via PutMetricData
 * - Integration with existing pino-based logger
 */

import type { LogLevel, LogEntry, CloudWatchLoggerConfig, MetricUnit } from './types.js';

// ── Redaction constants ──

const REDACTION_MASK = '[REDACTED]';

/**
 * Patterns for sensitive data that must be redacted before logging.
 * Each pattern captures the sensitive value portion for replacement.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
    // API keys: sk-..., sk_live_..., sk_test_..., rk-..., pk-..., etc.
    /\b(sk[-_][A-Za-z0-9_-]{20,})\b/g,
    /\b(pk[-_][A-Za-z0-9_-]{20,})\b/g,
    /\b(rk[-_][A-Za-z0-9_-]{20,})\b/g,
    /\b(api[-_]?key[-_:]?\s*[A-Za-z0-9_-]{16,})\b/gi,

    // Bearer tokens
    /Bearer\s+([A-Za-z0-9._~+/=-]+)/gi,

    // AWS access keys
    /\b(AKIA[0-9A-Z]{16})\b/g,

    // JWT-like tokens (three base64 segments separated by dots)
    /\b(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,

    // Password fields in JSON: "password": "value", "passwd": "value", "secret": "value"
    /("(?:password|passwd|secret|token|api_key|apiKey|access_token|refresh_token|client_secret)":\s*")([^"]+)(")/gi,

    // Password fields in key=value format: password=value
    /\b((?:password|passwd|secret|token|api_key|apiKey|access_token|refresh_token|client_secret)\s*=\s*)([^\s&,;]+)/gi,

    // Message content fields in JSON (WhatsApp message bodies should not be logged)
    /("(?:messageContent|message_content|body|messageBody|message_body)":\s*")([^"]+)(")/gi,

    // B2 (Wave 6): PII redaction
    // E.164 phone numbers (e.g. +6584731565), with or without spaces/dashes.
    /\+\d{1,3}[\s-]?\d{4,14}/g,
    // WhatsApp JID with phone (e.g. 6584731565@s.whatsapp.net)
    /\b\d{8,15}@s\.whatsapp\.net\b/g,
    // Email addresses (RFC 5322 simplified)
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

/**
 * Redacts sensitive data from a log string.
 *
 * Replaces all occurrences of sensitive patterns (API keys, bearer tokens,
 * passwords, message content) with a mask placeholder while preserving
 * the non-sensitive structure of the log entry.
 */
export function redactSensitiveData(input: string): string {
    let result = input;

    for (const pattern of SENSITIVE_PATTERNS) {
        // Reset lastIndex for global patterns
        pattern.lastIndex = 0;

        // Determine replacement strategy based on pattern structure
        if (pattern.source.includes('Bearer')) {
            // Bearer token: keep "Bearer " prefix, mask the token
            result = result.replace(pattern, (_match, _token) => `Bearer ${REDACTION_MASK}`);
        } else if (pattern.source.startsWith('("(?:password') || pattern.source.startsWith('("(?:message')) {
            // JSON key-value: preserve key and quotes, mask value
            result = result.replace(pattern, (_match, prefix, _value, suffix) => `${prefix}${REDACTION_MASK}${suffix}`);
        } else if (pattern.source.includes('(?:password|passwd|secret|token|api_key|apiKey|access_token|refresh_token|client_secret)\\s*=')) {
            // key=value format: preserve key=, mask value
            result = result.replace(pattern, (_match, prefix, _value) => `${prefix}${REDACTION_MASK}`);
        } else {
            // Direct token/key patterns: replace entire match
            result = result.replace(pattern, REDACTION_MASK);
        }
    }

    return result;
}

// ── CloudWatch Logger ──

export class CloudWatchLogger {
    private config: Required<CloudWatchLoggerConfig>;

    constructor(config: CloudWatchLoggerConfig = {}) {
        this.config = {
            region: config.region ?? 'ap-southeast-1',
            logGroupPrefix: config.logGroupPrefix ?? 'nanoclaw/app',
            metricsNamespace: config.metricsNamespace ?? 'NanoClaw/Application',
            flushIntervalMs: config.flushIntervalMs ?? 5000,
            maxBufferSize: config.maxBufferSize ?? 100,
            localFallback: config.localFallback ?? true,
        };
    }

    /**
     * Log a message at the specified level with automatic redaction.
     */
    log(level: LogLevel, message: string, context?: Record<string, unknown>): LogEntry {
        const redactedMessage = redactSensitiveData(message);
        const redactedContext = context
            ? JSON.parse(redactSensitiveData(JSON.stringify(context))) as Record<string, unknown>
            : undefined;

        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            message: redactedMessage,
            ...(redactedContext && { context: redactedContext }),
        };

        return entry;
    }

    info(message: string, context?: Record<string, unknown>): LogEntry {
        return this.log('INFO', message, context);
    }

    warn(message: string, context?: Record<string, unknown>): LogEntry {
        return this.log('WARNING', message, context);
    }

    error(message: string, context?: Record<string, unknown>): LogEntry {
        return this.log('ERROR', message, context);
    }

    /**
     * Emit a custom CloudWatch metric (B4 Wave 6).
     *
     * Uses fire-and-forget PutMetricData. Errors are swallowed so a failed
     * metric publish never breaks the calling code. The CloudWatch client
     * is created lazily so unit tests don't need the SDK.
     */
    emitMetric(metric: MetricUnit): void {
        // Lazy import — keeps test imports lightweight.
        import('@aws-sdk/client-cloudwatch')
            .then(({ CloudWatchClient, PutMetricDataCommand }) => {
                const client = new CloudWatchClient({ region: this.config.region });
                const cmd = new PutMetricDataCommand({
                    Namespace: this.config.metricsNamespace,
                    MetricData: [
                        {
                            MetricName: metric.name,
                            Value: metric.value,
                            Unit: metric.unit,
                            Timestamp: new Date(),
                            Dimensions: metric.dimensions
                                ? Object.entries(metric.dimensions).map(([Name, Value]) => ({ Name, Value }))
                                : undefined,
                        },
                    ],
                });
                return client.send(cmd);
            })
            .catch(() => {
                // Don't surface SDK errors to callers; metrics are best-effort.
            });
    }
}

export { REDACTION_MASK, SENSITIVE_PATTERNS };
export type { LogLevel, LogEntry, CloudWatchLoggerConfig, MetricUnit } from './types.js';
