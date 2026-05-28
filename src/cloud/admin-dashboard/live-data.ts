/**
 * Real-time admin dashboard data provider — replaces the hardcoded zeros
 * in the cloud-mode dashboard.
 *
 * Three live data sources, each lazy-imported so missing SDKs degrade
 * gracefully instead of crashing dashboard boot:
 *
 *   - ECS DescribeTasks → orchestrator + sub-agent task health, uptime, count.
 *     CloudWatch Container Insights (ECS/ContainerInsights) → per-task
 *     CPU/Memory.
 *   - DynamoDB Query/Scan on nanoclaw-chat-messages with timestamp keys for
 *     globalMessagesPerMinute / Hour / activeUsers.
 *   - Redis sorted-set keys "nanoclaw:rate:hits:{day}" → rateLimitHits24h.
 *
 * Each helper short-circuits on AWS errors and returns sentinel-empty
 * results so the dashboard renders something instead of breaking.
 */

import type { ContainersResponse, ContainerInfo, StatsResponse, RecentMessagesResponse, RecentMessage } from './types.js';
import type { CloudServices } from '../bootstrap.js';
import { log } from '../../log.js';

const ECS_CLUSTER = process.env.ECS_CLUSTER_NAME || 'nanoclaw-cluster';
const SUB_AGENT_SERVICE = process.env.ECS_SUB_AGENT_SERVICE || 'nanoclaw-sub-agent';
const AWS_REGION = process.env.AWS_REGION || 'ap-southeast-1';

// ── Containers (ECS tasks) ──

interface EcsTaskRaw {
    taskArn?: string;
    lastStatus?: string;
    desiredStatus?: string;
    cpu?: string;
    memory?: string;
    startedAt?: Date;
    createdAt?: Date;
    containers?: Array<{ name?: string; runtimeId?: string; lastStatus?: string }>;
    overrides?: { containerOverrides?: Array<{ name?: string }> };
    group?: string;
}

export async function getContainersLive(): Promise<ContainersResponse> {
    try {
        const { ECSClient, ListTasksCommand, DescribeTasksCommand } =
            await import('@aws-sdk/client-ecs');
        const ecs = new ECSClient({ region: AWS_REGION });

        const list = await ecs.send(new ListTasksCommand({
            cluster: ECS_CLUSTER,
            serviceName: SUB_AGENT_SERVICE,
            desiredStatus: 'RUNNING',
        }));
        const taskArns = list.taskArns ?? [];
        if (taskArns.length === 0) {
            return { total: 0, containers: [] };
        }

        const desc = await ecs.send(new DescribeTasksCommand({
            cluster: ECS_CLUSTER,
            tasks: taskArns,
        }));
        const tasks: EcsTaskRaw[] = (desc.tasks ?? []) as EcsTaskRaw[];

        // Pull per-task CPU/Memory utilisation from CloudWatch Container Insights.
        const utilByTaskId = await getContainerUtilization(taskArns);

        const containers: ContainerInfo[] = tasks.map(t => {
            const arn = t.taskArn ?? '';
            const taskId = arn.split('/').pop() ?? arn;
            const startedAt = t.startedAt instanceof Date ? t.startedAt : (t.startedAt ? new Date(t.startedAt) : null);
            const uptime = startedAt ? Math.floor((Date.now() - startedAt.getTime()) / 1000) : 0;
            const util = utilByTaskId.get(taskId) ?? { cpu: 0, memMb: 0 };
            const status = (t.lastStatus ?? 'UNKNOWN').toLowerCase();
            const mappedStatus: ContainerInfo['status'] =
                status === 'running' ? 'running' :
                status === 'stopped' ? 'stopped' :
                status === 'pending' || status === 'provisioning' ? 'starting' :
                'error';
            return {
                containerId: taskId,
                userId: t.group ?? SUB_AGENT_SERVICE,
                status: mappedStatus,
                uptime,
                memoryUsageMb: util.memMb,
                cpuPercent: util.cpu,
                lastActivity: (startedAt ?? new Date()).toISOString(),
            };
        });

        return { total: containers.length, containers };
    } catch (err) {
        log.warn('getContainersLive failed', { err: (err as Error).message });
        return { total: 0, containers: [] };
    }
}

async function getContainerUtilization(taskArns: string[]): Promise<Map<string, { cpu: number; memMb: number }>> {
    const out = new Map<string, { cpu: number; memMb: number }>();
    if (taskArns.length === 0) return out;
    try {
        const { CloudWatchClient, GetMetricDataCommand } = await import('@aws-sdk/client-cloudwatch');
        const cw = new CloudWatchClient({ region: AWS_REGION });
        const end = new Date();
        const start = new Date(end.getTime() - 5 * 60_000); // 5min window

        // Build query pairs per task: CpuUtilized, MemoryUtilized.
        const queries: Array<{ id: string; taskId: string; metric: 'CpuUtilized' | 'MemoryUtilized' }> = [];
        let idCounter = 0;
        for (const arn of taskArns.slice(0, 25)) { // CW caps at ~50 metrics; stay safe
            const taskId = arn.split('/').pop() ?? arn;
            queries.push({ id: `q${idCounter++}`, taskId, metric: 'CpuUtilized' });
            queries.push({ id: `q${idCounter++}`, taskId, metric: 'MemoryUtilized' });
        }
        if (queries.length === 0) return out;

        const resp = await cw.send(new GetMetricDataCommand({
            StartTime: start,
            EndTime: end,
            ScanBy: 'TimestampDescending',
            MetricDataQueries: queries.map(q => ({
                Id: q.id,
                MetricStat: {
                    Metric: {
                        Namespace: 'ECS/ContainerInsights',
                        MetricName: q.metric,
                        Dimensions: [
                            { Name: 'ClusterName', Value: ECS_CLUSTER },
                            { Name: 'TaskId', Value: q.taskId },
                        ],
                    },
                    Period: 60,
                    Stat: 'Average',
                },
                ReturnData: true,
            })),
        }));

        const byId = new Map<string, number>();
        for (const r of (resp.MetricDataResults ?? [])) {
            const last = (r.Values ?? [])[0];
            if (typeof last === 'number' && r.Id) byId.set(r.Id, last);
        }

        for (const q of queries) {
            const cur = out.get(q.taskId) ?? { cpu: 0, memMb: 0 };
            const v = byId.get(q.id) ?? 0;
            if (q.metric === 'CpuUtilized') cur.cpu = Math.round(v * 10) / 10; // CW returns vCPU ms; treat as %
            if (q.metric === 'MemoryUtilized') cur.memMb = Math.round(v * 10) / 10;
            out.set(q.taskId, cur);
        }
    } catch (err) {
        log.warn('getContainerUtilization failed', { err: (err as Error).message });
    }
    return out;
}

// ── Stats (rate, active users, hits) ──

export async function getStatsLive(services: CloudServices): Promise<StatsResponse> {
    const out: StatsResponse = {
        globalMessagesPerMinute: 0,
        globalMessagesPerHour: 0,
        activeUsers: 0,
        topUsers: [],
        rateLimitHits24h: 0,
    };

    // 1) Messages-per-minute / hour from chat-messages table.
    try {
        const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
        const ddb = services.dataGateway.dynamo;
        const tableName = services.dataGateway.cfg.dynamoDb.chatMessagesTable;
        const now = Date.now();
        const oneMinuteAgo = new Date(now - 60_000).toISOString();
        const oneHourAgo = new Date(now - 3_600_000).toISOString();

        // Light scan with FilterExpression — chatMessages is partitioned by userId,
        // so a global rolling-window query needs a scan. We cap with Limit and
        // ProjectionExpression to keep it cheap.
        const scan = await ddb.send(new ScanCommand({
            TableName: tableName,
            FilterExpression: '#ts >= :h',
            ExpressionAttributeNames: { '#ts': 'timestamp' },
            ExpressionAttributeValues: { ':h': oneHourAgo },
            ProjectionExpression: 'userId, #ts',
            Limit: 1000,
        }) as never) as { Items?: Array<{ userId?: string; timestamp?: string }>; Count?: number };

        const items = scan.Items ?? [];
        const userSet = new Set<string>();
        let perMin = 0;
        for (const it of items) {
            if (it.userId) userSet.add(it.userId);
            if (it.timestamp && it.timestamp >= oneMinuteAgo) perMin += 1;
        }
        out.globalMessagesPerHour = items.length;
        out.globalMessagesPerMinute = perMin;
        out.activeUsers = userSet.size;
    } catch (err) {
        log.warn('getStatsLive: chat-messages scan failed', { err: (err as Error).message });
    }

    // 2) Rate-limit hits over the last 24h from Redis (zcard on a daily zset).
    try {
        const day = new Date().toISOString().slice(0, 10);
        const yKey = `nanoclaw:rate:hits:${day}`;
        const yKeyPrev = `nanoclaw:rate:hits:${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}`;
        const [a, b] = await Promise.all([
            services.redis.zcard(yKey).catch(() => 0),
            services.redis.zcard(yKeyPrev).catch(() => 0),
        ]);
        out.rateLimitHits24h = (Number(a) || 0) + (Number(b) || 0);
    } catch (err) {
        log.warn('getStatsLive: redis rate-hits failed', { err: (err as Error).message });
    }

    return out;
}

// ── Recent messages ──

export async function getRecentMessagesLive(services: CloudServices): Promise<RecentMessagesResponse> {
    try {
        const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
        const ddb = services.dataGateway.dynamo;
        const tableName = services.dataGateway.cfg.dynamoDb.chatMessagesTable;
        const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString();

        const scan = await ddb.send(new ScanCommand({
            TableName: tableName,
            FilterExpression: '#ts >= :d',
            ExpressionAttributeNames: { '#ts': 'timestamp' },
            ExpressionAttributeValues: { ':d': oneDayAgo },
            ProjectionExpression: 'userId, #ts, role, messageId',
            Limit: 50,
        }) as never) as {
            Items?: Array<{ userId?: string; timestamp?: string; role?: string; messageId?: string }>;
            Count?: number;
            ScannedCount?: number;
        };

        const items = scan.Items ?? [];
        const messages: RecentMessage[] = items
            .sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))
            .slice(0, 20)
            .map(it => ({
                id: it.messageId ?? `${it.userId}-${it.timestamp}`,
                timestamp: it.timestamp ?? new Date().toISOString(),
                direction: it.role === 'assistant' ? 'outbound' : 'inbound',
                status: 'delivered' as const,
                userHash: hashUserId(it.userId ?? ''),
            }));

        return { messages, totalProcessed24h: scan.Count ?? items.length };
    } catch (err) {
        log.warn('getRecentMessagesLive failed', { err: (err as Error).message });
        return { messages: [], totalProcessed24h: 0 };
    }
}

function hashUserId(userId: string): string {
    if (!userId) return '????????';
    // Quick non-crypto hash — first 8 chars of djb2 hex
    let h = 5381;
    for (let i = 0; i < userId.length; i++) {
        h = ((h << 5) + h) + userId.charCodeAt(i);
    }
    return Math.abs(h).toString(16).padStart(8, '0').slice(0, 8);
}

// ── Bedrock spend (last-24h sum from CloudWatch Custom metric) ──

export interface BedrockSpendSnapshot {
    last24hUsd: number;
    last7dUsd: number;
    perDayUsd: number[]; // length 7, oldest first
    asOf: string;
}

export async function getBedrockSpendLive(): Promise<BedrockSpendSnapshot> {
    const out: BedrockSpendSnapshot = {
        last24hUsd: 0,
        last7dUsd: 0,
        perDayUsd: [0, 0, 0, 0, 0, 0, 0],
        asOf: new Date().toISOString(),
    };
    try {
        const { CloudWatchClient, GetMetricStatisticsCommand } = await import('@aws-sdk/client-cloudwatch');
        const cw = new CloudWatchClient({ region: AWS_REGION });
        const end = new Date();
        const start = new Date(end.getTime() - 7 * 86_400_000);

        // Custom metric emitted by our metric SDK — see logging/index.ts emitMetric.
        const resp = await cw.send(new GetMetricStatisticsCommand({
            Namespace: 'NanoClaw',
            MetricName: 'BedrockEstimatedCost',
            StartTime: start,
            EndTime: end,
            Period: 86_400, // 1 day
            Statistics: ['Sum'],
            Unit: 'None',
        }));
        const points = (resp.Datapoints ?? [])
            .map(p => ({ ts: (p.Timestamp ?? new Date()).getTime(), sum: Number(p.Sum ?? 0) }))
            .sort((a, b) => a.ts - b.ts);
        const perDay: number[] = [];
        for (let i = 6; i >= 0; i--) {
            const dayStart = new Date(end.getTime() - i * 86_400_000);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = dayStart.getTime() + 86_400_000;
            const sum = points.filter(p => p.ts >= dayStart.getTime() && p.ts < dayEnd).reduce((s, p) => s + p.sum, 0);
            perDay.push(Math.round(sum * 100) / 100);
        }
        out.perDayUsd = perDay;
        out.last7dUsd = Math.round(perDay.reduce((s, n) => s + n, 0) * 100) / 100;
        out.last24hUsd = perDay[perDay.length - 1] ?? 0;
    } catch (err) {
        log.warn('getBedrockSpendLive failed', { err: (err as Error).message });
    }
    return out;
}

// ── Redis queue depth ──

export interface QueueDepthSnapshot {
    pendingUploads: number;
    dataGatewayQueue: number;
    subAgentQueues: number;
    asOf: string;
}

export async function getQueueDepthLive(services: CloudServices): Promise<QueueDepthSnapshot> {
    const out: QueueDepthSnapshot = {
        pendingUploads: 0,
        dataGatewayQueue: 0,
        subAgentQueues: 0,
        asOf: new Date().toISOString(),
    };
    try {
        const [up, dg, agentKeys] = await Promise.all([
            services.redis.llen('nanoclaw:uploads:pending').catch(() => 0),
            services.redis.llen('queue:orchestrator:data_gateway').catch(() => 0),
            services.redis.keys('queue:agent:*').catch(() => [] as string[]),
        ]);
        out.pendingUploads = Number(up) || 0;
        out.dataGatewayQueue = Number(dg) || 0;
        let total = 0;
        for (const k of (agentKeys as string[]).slice(0, 100)) {
            const n = await services.redis.llen(k).catch(() => 0);
            total += Number(n) || 0;
        }
        out.subAgentQueues = total;
    } catch (err) {
        log.warn('getQueueDepthLive failed', { err: (err as Error).message });
    }
    return out;
}
