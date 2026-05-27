/**
 * Data tab — DynamoDB / OpenSearch / S3 stats + document listing & deletion.
 *
 * Implements DashboardDataProvider.getDataStats / listDocuments / deleteDocument
 * by talking to the existing DataGateway clients (dynamo, openSearch, s3).
 */

import type { CloudServices } from '../bootstrap.js';
import type {
    DataStats,
    DocumentEntry,
    DocumentsResponse,
    IngestionSourceConfig,
} from './types.js';
import {
    DescribeTableCommand,
    type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
    ListObjectsV2Command,
    DeleteObjectCommand,
    type S3Client,
} from '@aws-sdk/client-s3';
import { log } from '../../log.js';

// ── DataStats ────────────────────────────────────────────────────────────────

export async function getDataStats(services: CloudServices): Promise<DataStats> {
    const { dataGateway } = services;
    const cfg = dataGateway.cfg;

    // DynamoDB: DescribeTable for each table
    const tables: Array<{ name: string; itemCount: number; sizeBytes: number }> = [];
    const tableNames = [
        cfg.dynamoDb.chatMessagesTable,
        cfg.dynamoDb.webhookTokensTable,
        cfg.dynamoDb.userPreferencesTable,
        cfg.dynamoDb.systemErrorsTable,
    ].filter(Boolean);

    // Get the underlying DynamoDBClient (the DocumentClient wraps it).
    // The SDK's DescribeTable lives on the raw client.
    const ddbDocClient = dataGateway.dynamo as DynamoDBDocumentClient;
    // The raw client is hidden. Easier path: use the document client send() with the same command class.
    // Both share a transport, DescribeTable works through DocumentClient too.
    for (const name of tableNames) {
        try {
            const r = await ddbDocClient.send(new DescribeTableCommand({ TableName: name }));
            tables.push({
                name,
                itemCount: r.Table?.ItemCount ?? 0,
                sizeBytes: r.Table?.TableSizeBytes ?? 0,
            });
        } catch (err) {
            log.warn(`Data stats: DescribeTable failed for ${name}`, { err: err instanceof Error ? err.message : String(err) });
            tables.push({ name, itemCount: -1, sizeBytes: -1 });
        }
    }

    // OpenSearch: _stats on the index
    let osDocCount = 0;
    let osSizeBytes = 0;
    try {
        const r = await dataGateway.openSearch.indices.stats({ index: cfg.openSearch.indexName });
        // Type-loose access: the response shape is heavily typed but varies by version
        const statsBody = (r as { body?: Record<string, unknown> }).body ?? (r as Record<string, unknown>);
        const indices = (statsBody as { indices?: Record<string, { primaries?: { docs?: { count?: number }; store?: { size_in_bytes?: number } } }> }).indices;
        const idx = indices?.[cfg.openSearch.indexName];
        osDocCount = idx?.primaries?.docs?.count ?? 0;
        osSizeBytes = idx?.primaries?.store?.size_in_bytes ?? 0;
    } catch (err) {
        log.warn('Data stats: OpenSearch indices.stats failed', { err: err instanceof Error ? err.message : String(err) });
    }

    // S3: ListObjectsV2 across the entire bucket (paginated)
    let s3ObjectCount = 0;
    let s3SizeBytes = 0;
    try {
        let continuationToken: string | undefined = undefined;
        do {
            const r: { Contents?: Array<{ Size?: number }>; NextContinuationToken?: string; IsTruncated?: boolean } = await dataGateway.s3.send(
                new ListObjectsV2Command({
                    Bucket: cfg.s3.dataBucket,
                    ContinuationToken: continuationToken,
                    MaxKeys: 1000,
                }),
            );
            for (const obj of r.Contents ?? []) {
                s3ObjectCount += 1;
                s3SizeBytes += obj.Size ?? 0;
            }
            continuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
        } while (continuationToken);
    } catch (err) {
        log.warn('Data stats: S3 ListObjectsV2 failed', { err: err instanceof Error ? err.message : String(err) });
    }

    return {
        dynamodb: { tables },
        opensearch: {
            indexName: cfg.openSearch.indexName,
            documentCount: osDocCount,
            sizeBytes: osSizeBytes,
        },
        s3: {
            bucketName: cfg.s3.dataBucket,
            objectCount: s3ObjectCount,
            sizeBytes: s3SizeBytes,
        },
    };
}

// ── Documents listing (across all users + admin) ────────────────────────────

/**
 * Lists documents in S3 across ALL users (admin tab — privileged view).
 * Bucket layout: <userId>/<key>  where userId is either 'admin' or 'wa-<phoneHash>'.
 */
export async function listAllDocuments(
    services: CloudServices,
    filter: 'all' | 'admin' | 'user',
): Promise<DocumentsResponse> {
    const { dataGateway } = services;
    const documents: DocumentEntry[] = [];

    let continuationToken: string | undefined = undefined;
    try {
        do {
            const r: {
                Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date; ContentType?: string }>;
                NextContinuationToken?: string;
                IsTruncated?: boolean;
            } = await dataGateway.s3.send(
                new ListObjectsV2Command({
                    Bucket: dataGateway.cfg.s3.dataBucket,
                    ContinuationToken: continuationToken,
                    MaxKeys: 1000,
                }),
            );
            for (const obj of r.Contents ?? []) {
                if (!obj.Key) continue;
                const key = obj.Key;
                const slash = key.indexOf('/');
                const userPart = slash >= 0 ? key.substring(0, slash) : 'unknown';
                const filename = slash >= 0 ? key.substring(slash + 1) : key;
                const uploaderType: 'admin' | 'user' = userPart === 'admin' ? 'admin' : 'user';

                if (filter === 'admin' && uploaderType !== 'admin') continue;
                if (filter === 'user' && uploaderType !== 'user') continue;

                documents.push({
                    id: key,
                    filename,
                    sizeBytes: obj.Size ?? 0,
                    uploadedAt: (obj.LastModified ?? new Date()).toISOString(),
                    uploaderType,
                    uploaderId: userPart,
                });
            }
            continuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
        } while (continuationToken);
    } catch (err) {
        log.error('Data tab: listAllDocuments failed', { err: err instanceof Error ? err.message : String(err) });
    }

    documents.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

    return { documents, total: documents.length };
}

// ── Document deletion (S3 + best-effort OpenSearch cleanup) ─────────────────

export async function deleteDocument(
    services: CloudServices,
    documentId: string,
): Promise<{ success: boolean; message: string }> {
    const { dataGateway } = services;
    try {
        // Delete from S3
        await dataGateway.s3.send(
            new DeleteObjectCommand({
                Bucket: dataGateway.cfg.s3.dataBucket,
                Key: documentId,
            }),
        );

        // Best-effort: remove all OpenSearch chunks that reference this S3 key
        try {
            await dataGateway.openSearch.deleteByQuery({
                index: dataGateway.cfg.openSearch.indexName,
                body: {
                    query: { term: { 's3_key.keyword': documentId } },
                },
                refresh: true,
            });
        } catch (osErr) {
            log.warn('Data tab: OpenSearch deleteByQuery failed (S3 delete still succeeded)', {
                documentId,
                err: osErr instanceof Error ? osErr.message : String(osErr),
            });
        }

        return { success: true, message: `Deleted ${documentId}` };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Data tab: deleteDocument failed', { documentId, err: msg });
        return { success: false, message: msg };
    }
}

// ── Ingestion sources (declarative — wires from settings) ───────────────────

export function getIngestionSources(): IngestionSourceConfig[] {
    return [
        { id: 'gmail', name: 'Gmail', enabled: false, connected: false },
        { id: 'outlook', name: 'Outlook', enabled: false, connected: false },
        { id: 'gdrive', name: 'Google Drive', enabled: false, connected: false },
        { id: 'icloud', name: 'iCloud', enabled: false, connected: false },
        { id: 'file_watcher', name: 'Local file watcher', enabled: false, connected: false },
    ];
}
