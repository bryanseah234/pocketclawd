/**
 * S3 Auto-Reindex Job
 *
 * Scans the S3 bucket for user-uploaded files not yet indexed in OpenSearch.
 * Runs at startup then every 15 minutes.
 *
 * Uses the DG worker queue so indexing goes through the same path as normal uploads.
 */

import { log } from '../log.js';
import type { CloudServices } from './bootstrap.js';


const DG_QUEUE = 'queue:orchestrator:data_gateway';
const UPLOADS_PREFIX = 'uploads/';
const SEEN_TTL = 60 * 60 * 24 * 7; // 7-day sentinel in Redis

export async function runS3ReindexJob(services: CloudServices): Promise<void> {
    log.info('S3 reindex scan starting');
    let scanned = 0, queued = 0, skipped = 0;

    try {
        const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const bucket = services.config.s3.dataBucket;
        const region = process.env.AWS_REGION || 'ap-southeast-1';
        const s3 = new S3Client({ region });

        let continuationToken: string | undefined;
        do {
            const page = await s3.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: UPLOADS_PREFIX,
                ContinuationToken: continuationToken,
                MaxKeys: 1000,
            }));

            for (const obj of page.Contents ?? []) {
                const key = obj.Key!;
                if (!key || key.endsWith('/')) continue;
                scanned++;

                // Skip if recently queued
                const seenKey = `s3reindex:seen:${key}`;
                if (await services.redis.get(seenKey)) { skipped++; continue; }

                // Parse userId from uploads/<userId>/<filename>
                const parts = key.slice(UPLOADS_PREFIX.length).split('/');
                if (parts.length < 2) { skipped++; continue; }
                const userId = parts[0];
                const filename = parts.slice(1).join('/');
                if (!userId || !filename) { skipped++; continue; }

                // Check OpenSearch count for this key
                try {
                    const { dataGateway } = services;
                    const countResult = await (dataGateway as any).openSearchClient?.count({
                        index: services.config.openSearch.indexName,
                        body: { query: { bool: { must: [
                            { term: { userId } },
                            { term: { 's3Key.keyword': key } },
                        ]}}},
                    });
                    const docCount = countResult?.body?.count ?? 0;
                    if (docCount > 0) {
                        await services.redis.setex(seenKey, SEEN_TTL, '1');
                        skipped++;
                        continue;
                    }
                } catch {
                    // Can't check — queue it anyway (idempotent on OS side)
                }

                // Push to DG worker queue
                const payload = JSON.stringify({
                    action: 'index_s3_object',
                    userId,
                    s3Key: key,
                    filename,
                    bucket,
                    queuedAt: new Date().toISOString(),
                });
                await services.redis.lpush(DG_QUEUE, payload);
                await services.redis.setex(seenKey, SEEN_TTL, '1');
                queued++;
                log.info('Queued for indexing', { userId, key });
            }

            continuationToken = page.NextContinuationToken;
        } while (continuationToken);

        log.info('S3 reindex scan complete', { scanned, queued, skipped });
    } catch (err) {
        log.error('S3 reindex scan failed', { err: String(err) });
    }
}

export function scheduleS3ReindexJob(services: CloudServices): NodeJS.Timeout {
    void runS3ReindexJob(services);
    return setInterval(() => void runS3ReindexJob(services), 15 * 60 * 1000);
}
