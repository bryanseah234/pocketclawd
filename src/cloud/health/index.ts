
/**

 * Health Check Aggregator — monitors system health and emits CloudWatch metrics.

 *

 * Responsibilities:

 * - Aggregate health from all subsystems (Redis, DynamoDB, OpenSearch, WhatsApp, containers)

 * - Provide /health endpoint response

 * - Hourly WhatsApp session health check with admin alerting on expiry

 * - Container health monitoring: detect OOM (exit 137), repeated crashes (>3 in 5min → quarantine)

 * - Emit CloudWatch custom metrics: ActiveContainers, MessagesPerMinute, ProcessingLatency, LLMLatency, VectorSearchLatency

 *

 * Requirements: REQ-6.1, REQ-6.3

 */



import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';



import { log } from '../../log.js';



import type {

    ComponentHealth,

    ComponentStatus,

    ContainerFailureEvent,

    CustomMetric,

    HealthCheckConfig,

    HealthDependencies,

    HealthResponse,

    WhatsAppSessionHealth,

} from './types.js';



export type {

    ComponentHealth,

    ComponentStatus,

    ContainerFailureEvent,

    CustomMetric,

    HealthCheckConfig,

    HealthDependencies,

    HealthResponse,

    WhatsAppSessionHealth,

} from './types.js';



// ── Default configuration ──



const DEFAULT_CONFIG: Required<HealthCheckConfig> = {

    region: 'ap-southeast-1',

    metricsNamespace: 'NanoClaw/Application',

    sessionCheckIntervalMs: 3_600_000, // 1 hour

    crashWindowMs: 300_000, // 5 minutes

    maxCrashesBeforeQuarantine: 3,

};



// ── Health Check Aggregator ──



export class HealthCheckAggregator {

    private readonly config: Required<HealthCheckConfig>;

    private readonly deps: HealthDependencies;

    private readonly cloudwatch: CloudWatchClient;

    private readonly startTime: number;



    private sessionCheckTimer: ReturnType<typeof setInterval> | null = null;

    private lastSessionHealth: WhatsAppSessionHealth | null = null;

    private readonly recentFailures: ContainerFailureEvent[] = [];



    constructor(deps: HealthDependencies, config: HealthCheckConfig = {}) {

        this.config = { ...DEFAULT_CONFIG, ...config };

        this.deps = deps;

        this.cloudwatch = new CloudWatchClient({ region: this.config.region });

        this.startTime = Date.now();

    }



    // ── Lifecycle ──



    /**

     * Start periodic health checks (WhatsApp session check every hour).

     */

    start(): void {

        this.sessionCheckTimer = setInterval(

            () => { void this.checkWhatsAppSessionHealth(); },

            this.config.sessionCheckIntervalMs,

        );



        // Run an initial session check

        void this.checkWhatsAppSessionHealth();



        log.info('Health check aggregator started', {

            sessionCheckIntervalMs: this.config.sessionCheckIntervalMs,

        });

    }



    /**

     * Stop all periodic health checks and clean up.

     */

    stop(): void {

        if (this.sessionCheckTimer) {

            clearInterval(this.sessionCheckTimer);

            this.sessionCheckTimer = null;

        }

    }



    // ── /health endpoint ──



    /**

     * Get the aggregated health status for the /health endpoint.

     * Checks all subsystems and returns a structured response.

     */

    async getHealth(): Promise<HealthResponse> {

        const [redis, dynamodb, opensearch, whatsapp] = await Promise.all([

            this.checkComponent('redis', this.deps.checkRedis),

            this.checkComponent('dynamodb', this.deps.checkDynamoDB),

            this.checkComponent('opensearch', this.deps.checkOpenSearch),

            this.checkWhatsAppComponent(),

        ]);



        const activeContainers = this.deps.getActiveContainerCount();

        const quarantinedCount = this.deps.getQuarantinedCount();



        // Overall status: unhealthy if any critical component is unhealthy

        const componentStatuses = [redis.status, dynamodb.status, opensearch.status];

        let overallStatus: ComponentStatus = 'healthy';

        if (componentStatuses.includes('unhealthy')) {

            overallStatus = 'unhealthy';

        } else if (componentStatuses.includes('degraded') || whatsapp.status === 'unhealthy') {

            overallStatus = 'degraded';

        }



        const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);



        return {

            status: overallStatus,

            timestamp: new Date().toISOString(),

            uptime: uptimeSeconds,

            components: {

                redis,

                dynamodb,

                opensearch,

                whatsappSession: whatsapp,

            },

            containers: {

                active: activeContainers,

                quarantined: quarantinedCount,

            },

        };

    }



    // ── WhatsApp Session Health ──



    /**

     * Perform an hourly WhatsApp session health check.

     * Alerts admin if session is expired or about to expire.

     */

    async checkWhatsAppSessionHealth(): Promise<WhatsAppSessionHealth> {

        try {

            const health = await this.deps.checkWhatsAppSession();

            this.lastSessionHealth = health;



            if (!health.valid) {

                log.error('WhatsApp session is invalid', { health });

                await this.deps.sendAdminAlert(

                    `WhatsApp session is invalid: ${health.message ?? 'Session expired or disconnected'}`,

                    'critical',

                );

            }



            return health;

        } catch (err) {

            const errorMessage = err instanceof Error ? err.message : String(err);

            log.error('WhatsApp session health check failed', { error: errorMessage });



            const failedHealth: WhatsAppSessionHealth = {

                valid: false,

                lastChecked: new Date().toISOString(),

                message: `Health check error: ${errorMessage}`,

            };

            this.lastSessionHealth = failedHealth;



            await this.deps.sendAdminAlert(

                `WhatsApp session health check failed: ${errorMessage}`,

                'critical',

            );



            return failedHealth;

        }

    }



    // ── Container Health Monitoring ──



    /**

     * Record a container failure event.

     * Detects OOM kills (exit 137) and tracks repeated crashes for quarantine decisions.

     */

    recordContainerFailure(event: ContainerFailureEvent): void {

        this.recentFailures.push(event);



        // Prune old failures outside the crash window

        const windowStart = Date.now() - this.config.crashWindowMs;

        const cutoffIndex = this.recentFailures.findIndex(

            (f) => new Date(f.timestamp).getTime() >= windowStart,

        );

        if (cutoffIndex > 0) {

            this.recentFailures.splice(0, cutoffIndex);

        }



        // Log OOM kills specifically

        if (event.exitCode === 137) {

            log.error('Container OOM killed', {

                userId: event.userId,

                exitCode: event.exitCode,

            });

        }

    }



    /**

     * Check if a user's container should be quarantined based on recent crash history.

     * Returns true if the user has more than maxCrashesBeforeQuarantine failures

     * within the crash window.

     */

    shouldQuarantine(userId: string): boolean {

        const windowStart = Date.now() - this.config.crashWindowMs;

        const userFailures = this.recentFailures.filter(

            (f) => f.userId === userId && new Date(f.timestamp).getTime() >= windowStart,

        );

        return userFailures.length > this.config.maxCrashesBeforeQuarantine;

    }



    /**

     * Get recent container failure events (for diagnostics).

     */

    getRecentFailures(): ContainerFailureEvent[] {

        return [...this.recentFailures];

    }



    // ── CloudWatch Custom Metrics ──



    /**

     * Emit a custom CloudWatch metric.

     */

    async emitMetric(metric: CustomMetric): Promise<void> {

        try {

            await this.cloudwatch.send(new PutMetricDataCommand({

                Namespace: this.config.metricsNamespace,

                MetricData: [

                    {

                        MetricName: metric.name,

                        Value: metric.value,

                        Unit: metric.unit === 'Milliseconds' ? 'Milliseconds'

                            : metric.unit === 'Count' ? 'Count'

                                : 'None',

                        Timestamp: metric.timestamp ? new Date(metric.timestamp) : new Date(),

                        Dimensions: metric.dimensions

                            ? Object.entries(metric.dimensions).map(([Name, Value]) => ({ Name, Value }))

                            : undefined,

                    },

                ],

            }));

        } catch (err) {

            log.error('Failed to emit CloudWatch metric', {

                metric: metric.name,

                error: err instanceof Error ? err.message : String(err),

            });

        }

    }



    /**

     * Emit multiple metrics in a single PutMetricData call (up to 1000 per call).

     */

    async emitMetrics(metrics: CustomMetric[]): Promise<void> {

        if (metrics.length === 0) return;



        // CloudWatch allows up to 1000 metric data points per call

        const BATCH_SIZE = 1000;

        for (let i = 0; i < metrics.length; i += BATCH_SIZE) {

            const batch = metrics.slice(i, i + BATCH_SIZE);



            try {

                await this.cloudwatch.send(new PutMetricDataCommand({

                    Namespace: this.config.metricsNamespace,

                    MetricData: batch.map((m) => ({

                        MetricName: m.name,

                        Value: m.value,

                        Unit: m.unit === 'Milliseconds' ? 'Milliseconds'

                            : m.unit === 'Count' ? 'Count'

                                : 'None',

                        Timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),

                        Dimensions: m.dimensions

                            ? Object.entries(m.dimensions).map(([Name, Value]) => ({ Name, Value }))

                            : undefined,

                    })),

                }));

            } catch (err) {

                log.error('Failed to emit CloudWatch metrics batch', {

                    batchSize: batch.length,

                    error: err instanceof Error ? err.message : String(err),

                });

            }

        }

    }



    /**

     * Convenience: emit the standard set of operational metrics.

     * Call this periodically (e.g., every minute) from the orchestrator.

     */

    async emitOperationalMetrics(data: {

        activeContainers: number;

        messagesPerMinute: number;

        processingLatencyMs?: number;

        llmLatencyMs?: number;

        vectorSearchLatencyMs?: number;

    }): Promise<void> {

        const metrics: CustomMetric[] = [

            { name: 'ActiveContainers', value: data.activeContainers, unit: 'Count' },

            { name: 'MessagesPerMinute', value: data.messagesPerMinute, unit: 'Count' },

        ];



        if (data.processingLatencyMs !== undefined) {

            metrics.push({ name: 'ProcessingLatency', value: data.processingLatencyMs, unit: 'Milliseconds' });

        }

        if (data.llmLatencyMs !== undefined) {

            metrics.push({ name: 'LLMLatency', value: data.llmLatencyMs, unit: 'Milliseconds' });

        }

        if (data.vectorSearchLatencyMs !== undefined) {

            metrics.push({ name: 'VectorSearchLatency', value: data.vectorSearchLatencyMs, unit: 'Milliseconds' });

        }



        await this.emitMetrics(metrics);

    }



    // ── Private helpers ──



    /**

     * Check a single component's health with timing.

     */

    private async checkComponent(

        _name: string,

        checker: () => Promise<boolean>,

    ): Promise<ComponentHealth> {

        const start = Date.now();

        try {

            const healthy = await checker();

            const latencyMs = Date.now() - start;

            return {

                status: healthy ? 'healthy' : 'unhealthy',

                latencyMs,

                lastChecked: new Date().toISOString(),

            };

        } catch (err) {

            const latencyMs = Date.now() - start;

            return {

                status: 'unhealthy',

                latencyMs,

                message: err instanceof Error ? err.message : String(err),

                lastChecked: new Date().toISOString(),

            };

        }

    }



    /**

     * Get WhatsApp session health as a ComponentHealth object.

     * Uses cached result from the last hourly check if available.

     */

    private async checkWhatsAppComponent(): Promise<ComponentHealth> {

        if (this.lastSessionHealth) {

            return {

                status: this.lastSessionHealth.valid ? 'healthy' : 'unhealthy',

                message: this.lastSessionHealth.message,

                lastChecked: this.lastSessionHealth.lastChecked,

            };

        }



        // No cached result — perform a fresh check

        const start = Date.now();

        try {

            const health = await this.deps.checkWhatsAppSession();

            this.lastSessionHealth = health;

            return {

                status: health.valid ? 'healthy' : 'unhealthy',

                latencyMs: Date.now() - start,

                message: health.message,

                lastChecked: health.lastChecked,

            };

        } catch (err) {

            return {

                status: 'unknown',

                latencyMs: Date.now() - start,

                message: err instanceof Error ? err.message : String(err),

                lastChecked: new Date().toISOString(),

            };

        }

    }

}


