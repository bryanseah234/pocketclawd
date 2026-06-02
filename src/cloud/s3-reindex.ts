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


// Wave 5: scan the prefixes where user/corporate files actually live.
// Old code scanned 'uploads/' which holds nothing -- the safety net found
// nothing and did nothing, forever. User docs land under users/<userId>/...
// (staging/ then documents/), corporate docs under corporate/<uploadId>/...
const INDEXING_QUEUE = 'queue:orchestrator:indexing';
const SCAN_PREFIXES = ['users/', 'corporate/'];
const SEEN_TTL = 60 * 60 * 24 * 7; // 7-day sentinel in Redis

export async function runS3ReindexJob(services: CloudServices): Promise<void> {
    log.info('S3 reindex scan starting');
    let scanned = 0, queued = 0, skipped = 0;

    try {
        const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
        const bucket = services.config.s3.dataBucket;
        const region = process.env.AWS_REGION || 'ap-southeast-1';
        const s3 = new S3Client({ region });

        for (const prefix of SCAN_PREFIXES) {
        let continuationToken: string | undefined;
        do {
            const page = await s3.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
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

                // Resolve userId + filename per prefix layout:
                //   users/<userId>/(staging/<uploadId>|documents)/<filename>
                //   corporate/<uploadId>/<filename>  -> userId = 'CORPORATE'
                const rest = key.slice(prefix.length).split('/');
                let userId: string;
                let filename: string;
                if (prefix === 'corporate/') {
                    if (rest.length < 2) { skipped++; continue; }
                    userId = 'CORPORATE';
                    filename = rest.slice(1).join('/');
                } else {
                    // users/<userId>/.../<filename>
                    if (rest.length < 2) { skipped++; continue; }
                    userId = rest[0];
                    filename = rest[rest.length - 1];
                }
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

                // Push straight to the indexer queue (same shape the
                // upload-worker uses) so re-index goes through one code path.
                const payload = JSON.stringify({
                    id: `s3reindex-${Date.now()}`,
                    userId,
                    type: 'index_file',
                    payload: {
                        s3Key: key, filename,
                        bucket,
                        corporate: userId === 'CORPORATE',
                        origin: 'upload_worker',
                        realUserId: userId,
                        channelType: null,
                        platformId: null,
                    },
                    timestamp: new Date().toISOString(),
                });
                await services.redis.lpush(INDEXING_QUEUE, payload);
                await services.redis.setex(seenKey, SEEN_TTL, '1');
                queued++;
                log.info('Queued for indexing', { userId, key });
            }

            continuationToken = page.NextContinuationToken;
        } while (continuationToken);
        }

        log.info('S3 reindex scan complete', { scanned, queued, skipped });
    } catch (err) {
        log.error('S3 reindex scan failed', { err: String(err) });
    }
}

export function scheduleS3ReindexJob(services: CloudServices): NodeJS.Timeout {
    void runS3ReindexJob(services);
    return setInterval(() => void runS3ReindexJob(services), 15 * 60 * 1000);
}
