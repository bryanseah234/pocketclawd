/**

 * Data Gateway — centralized data access module that enforces userId isolation

 * on ALL persistence operations. This is the sole path to DynamoDB, OpenSearch,

 * and S3 from the orchestrator and sub-agents.

 *

 * Requirements: REQ-7.1, REQ-2.1, REQ-2.2, REQ-2.3

 */



import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

import {

    S3Client,

    PutObjectCommand,

    GetObjectCommand,

    ListObjectsV2Command,

    DeleteObjectCommand,

} from '@aws-sdk/client-s3';

import { Upload } from '@aws-sdk/lib-storage';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

import { Client as OpenSearchClient } from '@opensearch-project/opensearch';

import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';

import { defaultProvider } from '@aws-sdk/credential-provider-node';

import { Readable } from 'node:stream';



import type {

    AuditLogEntry,

    ChatMessage,

    DataGatewayConfig,

    DeletionReceipt,

    DocumentChunk,

    FileMetadata,

    IDataGateway,

    PaginatedChatHistory,

    SearchResult,

    SystemError,

    TokenValidation,

    UserDataExport,

    UserPreferences,

} from './types.js';



export type { IDataGateway } from './types.js';

export * from './types.js';



export class DataGateway implements IDataGateway {

    /**

     * Reserved sentinel userId for corporate (admin-uploaded) documents that are

     * searchable by every user but writable only via the upload-worker path.

     * `assertUserId` rejects this value as a regular userId; only

     * `indexCorporateDocument` is allowed to use it for writes.

     * See data-isolation-corporate-docs spec, Requirements 1.x / 7.x.

     */

    public static readonly CORPORATE_SENTINEL = 'CORPORATE';



    private dynamoClient: DynamoDBDocumentClient;

    private s3Client: S3Client;

    private openSearchClient: OpenSearchClient;

    private config: DataGatewayConfig;

    private initialized = false;



    private constructor(config: DataGatewayConfig, region: string) {

        this.config = config;



        // Initialize DynamoDB DocumentClient with marshalling options

        const ddbClient = new DynamoDBClient({ region });

        this.dynamoClient = DynamoDBDocumentClient.from(ddbClient, {

            marshallOptions: {

                removeUndefinedValues: true,

                convertEmptyValues: false,

            },

            unmarshallOptions: {

                wrapNumbers: false,

            },

        });



        // Initialize S3 client

        this.s3Client = new S3Client({ region });



        // Initialize OpenSearch client with AWS SigV4 signing

        this.openSearchClient = new OpenSearchClient({

            ...AwsSigv4Signer({

                region,

                service: 'aoss', // OpenSearch Serverless

                getCredentials: () => defaultProvider()(),

            }),

            node: config.openSearch.endpoint,

        });



        this.initialized = true;

    }



    /**

     * Create a DataGateway instance by loading configuration from AWS Secrets Manager.

     * This is the primary factory method for production use.

     */

    static async create(options?: { region?: string; secretId?: string }): Promise<DataGateway> {

        const region = options?.region ?? 'ap-southeast-1';

        const secretId = options?.secretId ?? 'nanoclaw/app-config';



        const secretsClient = new SecretsManagerClient({ region });

        const response = await secretsClient.send(

            new GetSecretValueCommand({ SecretId: secretId }),

        );



        if (!response.SecretString) {

            throw new Error(`Secret ${secretId} has no string value`);

        }



        const secretConfig = JSON.parse(response.SecretString) as Record<string, unknown>;



        const config: DataGatewayConfig = {

            region,

            dynamoDb: {

                chatMessagesTable: (secretConfig.dynamodb_chat_messages_table as string) ?? 'nanoclaw-chat-messages',

                webhookTokensTable: (secretConfig.dynamodb_webhook_tokens_table as string) ?? 'nanoclaw-webhook-tokens',

                userPreferencesTable: (secretConfig.dynamodb_user_preferences_table as string) ?? 'nanoclaw-user-preferences',

                systemErrorsTable: (secretConfig.dynamodb_system_errors_table as string) ?? 'nanoclaw-system-errors',

            },

            openSearch: {

                endpoint: secretConfig.opensearch_endpoint as string,

                indexName: (secretConfig.opensearch_index_name as string) ?? 'documents',

            },

            s3: {

                dataBucket: secretConfig.s3_data_bucket as string,

            },

        };



        return new DataGateway(config, region);

    }



    /**

     * Create a DataGateway instance with explicit configuration.

     * Useful for testing and local development.

     */

    static createWithConfig(config: DataGatewayConfig): DataGateway {

        return new DataGateway(config, config.region);

    }



    // ── Accessors for internal clients (used by method implementations) ──



    /** @internal */

    get dynamo(): DynamoDBDocumentClient {

        return this.dynamoClient;

    }



    /** @internal */

    get s3(): S3Client {

        return this.s3Client;

    }



    /** @internal */

    get openSearch(): OpenSearchClient {

        return this.openSearchClient;

    }



    /** @internal */

    get cfg(): DataGatewayConfig {

        return this.config;

    }



    get isInitialized(): boolean {

        return this.initialized;

    }



    // ── TTL constants (in seconds) ──



    private static readonly TTL_CHAT_MESSAGES = 7_776_000;   // 90 days

    private static readonly TTL_WEBHOOK_TOKENS = 900;         // 15 minutes

    private static readonly TTL_SYSTEM_ERRORS = 2_592_000;    // 30 days



    // ── DynamoDB operations ──



    async putChatMessage(userId: string, message: ChatMessage): Promise<void> {

        this.assertUserId(userId);



        const now = new Date(message.timestamp);

        const ttl = Math.floor(now.getTime() / 1000) + DataGateway.TTL_CHAT_MESSAGES;



        await this.dynamoClient.send(new PutCommand({

            TableName: this.config.dynamoDb.chatMessagesTable,

            Item: {

                userId,

                timestamp: message.timestamp,

                messageId: message.messageId,

                role: message.role,

                content: message.content,

                metadata: message.metadata,

                ttl,

            },

        }));

    }



    async getChatHistory(userId: string, limit: number): Promise<ChatMessage[]> {

        this.assertUserId(userId);



        const result = await this.dynamoClient.send(new QueryCommand({

            TableName: this.config.dynamoDb.chatMessagesTable,

            KeyConditionExpression: 'userId = :uid',

            ExpressionAttributeValues: { ':uid': userId },

            ScanIndexForward: false, // newest first

            Limit: limit,

        }));



        return (result.Items ?? []).map((item) => ({

            messageId: item.messageId as string,

            role: item.role as 'user' | 'assistant',

            content: item.content as string,

            timestamp: item.timestamp as string,

            metadata: item.metadata as Record<string, unknown> | undefined,

        }));

    }



    async getChatHistoryPaginated(

        userId: string,

        limit: number,

        lastEvaluatedKey?: Record<string, unknown>,

    ): Promise<PaginatedChatHistory> {

        this.assertUserId(userId);



        const result = await this.dynamoClient.send(new QueryCommand({

            TableName: this.config.dynamoDb.chatMessagesTable,

            KeyConditionExpression: 'userId = :uid',

            ExpressionAttributeValues: { ':uid': userId },

            ScanIndexForward: false, // newest first

            Limit: limit,

            ExclusiveStartKey: lastEvaluatedKey,

        }));



        const messages: ChatMessage[] = (result.Items ?? []).map((item) => ({

            messageId: item.messageId as string,

            role: item.role as 'user' | 'assistant',

            content: item.content as string,

            timestamp: item.timestamp as string,

            metadata: item.metadata as Record<string, unknown> | undefined,

        }));



        return {

            messages,

            lastEvaluatedKey: result.LastEvaluatedKey as Record<string, unknown> | undefined,

        };

    }



    async putUserPreference(userId: string, prefs: UserPreferences): Promise<void> {

        this.assertUserId(userId);



        await this.dynamoClient.send(new PutCommand({

            TableName: this.config.dynamoDb.userPreferencesTable,

            Item: {

                userId,

                ...prefs,

            },

        }));

    }



    async getUserPreference(userId: string): Promise<UserPreferences | null> {

        this.assertUserId(userId);



        const result = await this.dynamoClient.send(new GetCommand({

            TableName: this.config.dynamoDb.userPreferencesTable,

            Key: { userId },

        }));



        if (!result.Item) {

            return null;

        }



        return {

            autoSave: result.Item.autoSave as boolean,

            notificationTime: result.Item.notificationTime as string,

            slideTemplate: result.Item.slideTemplate as UserPreferences['slideTemplate'],

            consentGiven: result.Item.consentGiven as boolean,

            consentTimestamp: result.Item.consentTimestamp as string | undefined,

            technical_depth: result.Item.technical_depth as UserPreferences['technical_depth'],

            primary_domain: result.Item.primary_domain as UserPreferences['primary_domain'],

            discoveryCompleted: result.Item.discoveryCompleted as boolean | undefined,

            discoveryCompletedAt: result.Item.discoveryCompletedAt as string | undefined,

        };

    }



    async createWebhookToken(userId: string, tokenHash: string): Promise<void> {

        this.assertUserId(userId);



        const now = new Date();

        const ttl = Math.floor(now.getTime() / 1000) + DataGateway.TTL_WEBHOOK_TOKENS;



        await this.dynamoClient.send(new PutCommand({

            TableName: this.config.dynamoDb.webhookTokensTable,

            Item: {

                tokenHash,

                userId,

                createdAt: now.toISOString(),

                ttl,

            },

        }));

    }



    async validateWebhookToken(tokenHash: string): Promise<TokenValidation> {

        // Get the token record

        const result = await this.dynamoClient.send(new GetCommand({

            TableName: this.config.dynamoDb.webhookTokensTable,

            Key: { tokenHash },

        }));



        if (!result.Item) {

            return { valid: false, reason: 'not_found' };

        }



        // Check TTL expiry (DynamoDB TTL deletion is eventually consistent,

        // so we must also check manually)

        const nowEpoch = Math.floor(Date.now() / 1000);

        if (result.Item.ttl && (result.Item.ttl as number) <= nowEpoch) {

            return { valid: false, reason: 'expired' };

        }



        // Token is valid — delete it to enforce one-time use

        await this.dynamoClient.send(new DeleteCommand({

            TableName: this.config.dynamoDb.webhookTokensTable,

            Key: { tokenHash },

            ConditionExpression: 'attribute_exists(tokenHash)',

        }));



        return { valid: true, userId: result.Item.userId as string };

    }



    async logSystemError(userId: string, error: SystemError): Promise<void> {

        this.assertUserId(userId);



        const now = new Date();

        const ttl = Math.floor(now.getTime() / 1000) + DataGateway.TTL_SYSTEM_ERRORS;



        await this.dynamoClient.send(new PutCommand({

            TableName: this.config.dynamoDb.systemErrorsTable,

            Item: {

                userId,

                timestamp: now.toISOString(),

                errorType: error.errorType,

                message: error.message,

                stackTrace: error.stackTrace,

                ttl,

            },

        }));

    }



    // ── OpenSearch operations ──



    /**

     * Ensure the documents index exists with proper mappings.

     * Creates the index with knn_vector (1024 dims, cosinesimil, nmslib) if it doesn't exist.

     * Call during initialization or from setup scripts.

     */

    async ensureIndex(): Promise<void> {

        const indexName = this.config.openSearch.indexName;



        try {

            const exists = await this.openSearchClient.indices.exists({ index: indexName });

            if (exists.body) {

                return;

            }

        } catch {

            // Index doesn't exist, proceed to create

        }



        await this.openSearchClient.indices.create({

            index: indexName,

            body: {

                settings: {

                    'index.knn': true,

                    'index.knn.algo_param.ef_search': 512,

                    number_of_shards: 2,

                    number_of_replicas: 1,

                },

                mappings: {

                    properties: {

                        id: { type: 'keyword' },

                        userId: { type: 'keyword' },

                        docType: { type: 'keyword' },

                        content: { type: 'text', analyzer: 'standard' },

                        contentVector: {

                            type: 'knn_vector',

                            dimension: 1024,

                            method: {

                                name: 'hnsw',

                                space_type: 'cosinesimil',

                                engine: 'nmslib',

                            },

                        },

                        filename: { type: 'keyword' },

                        pageNumber: { type: 'integer' },

                        chunkIndex: { type: 'integer' },

                        uploadedAt: { type: 'date' },

                    },

                },

            },

        });

        // Ensure sourceUrl is keyword-mapped (idempotent). Required for /forget-url.
        try {
            await this.openSearchClient.indices.putMapping({
                index: indexName,
                body: { properties: { sourceUrl: { type: 'keyword' } } },
            });
        } catch {
            // Non-critical: field may already exist
        }

    }



    /**

     * Index a document chunk with userId, contentVector, and metadata.

     * Requirements: REQ-2.2, REQ-7.1

     */

    async indexDocument(userId: string, chunk: DocumentChunk): Promise<void> {

        this.assertUserId(userId);



        const indexName = this.config.openSearch.indexName;



        const body: Record<string, unknown> = {

            id: chunk.id,

            userId,

            docType: chunk.docType,

            content: chunk.content,

            contentVector: chunk.contentVector,

            filename: chunk.filename,

            pageNumber: chunk.pageNumber,

            chunkIndex: chunk.chunkIndex,

            uploadedAt: chunk.uploadedAt,

        };

        // R6: persist sourceUrl when present so /ingested + /forget-url can

        // group by URL and delete by URL.

        if (chunk.sourceUrl) {

            body.sourceUrl = chunk.sourceUrl;

        }



        await this.openSearchClient.index({

            index: indexName,

            body,

        });

    }



    /**

     * Index a corporate document chunk that all users can search.

     * This bypasses the regular per-user `assertUserId` check (since CORPORATE is

     * the reserved sentinel) and is the ONLY method allowed to write under that userId.

     * Caller (DataGateway Worker) must verify origin === 'upload_worker' before invoking.

     * Requirements: data-isolation-corporate-docs Req 1.1 / 1.2 / 1.3.

     */

    async indexCorporateDocument(chunk: DocumentChunk): Promise<void> {

        if (!chunk || !chunk.id) {

            throw new Error('DataGateway.indexCorporateDocument: chunk.id is required');

        }



        const indexName = this.config.openSearch.indexName;



        await this.openSearchClient.index({

            index: indexName,

            body: {

                id: chunk.id,

                userId: DataGateway.CORPORATE_SENTINEL,

                docType: chunk.docType,

                content: chunk.content,

                contentVector: chunk.contentVector,

                filename: chunk.filename,

                pageNumber: chunk.pageNumber,

                chunkIndex: chunk.chunkIndex,

                uploadedAt: chunk.uploadedAt,

            },

        });

    }



    /**

     * Hybrid search combining 70% knn vector similarity + 30% BM25 text matching.

     * Enforces userId filter on ALL queries for data isolation.

     * Requirements: REQ-2.2, REQ-3.3, REQ-7.1

     */

    async hybridSearch(userId: string, query: string, vector: number[], topK: number): Promise<SearchResult[]> {

        this.assertUserId(userId);



        const indexName = this.config.openSearch.indexName;



        // Execute vector (knn) search with userId filter

        const knnResponse = await this.openSearchClient.search({

            index: indexName,

            body: {

                size: topK,

                query: {

                    bool: {

                        must: [

                            {

                                knn: {

                                    contentVector: {

                                        vector,

                                        k: topK,

                                    },

                                },

                            },

                        ],

                        filter: [

                            {

                                bool: {

                                    should: [

                                        { term: { userId } },

                                        { term: { userId: DataGateway.CORPORATE_SENTINEL } },

                                    ],

                                    minimum_should_match: 1,

                                },

                            },

                        ],

                    },

                },

                _source: { excludes: ['contentVector'] },

            },

        });



        // Execute BM25 text search with userId filter

        const bm25Response = await this.openSearchClient.search({

            index: indexName,

            body: {

                size: topK,

                query: {

                    bool: {

                        must: [

                            {

                                match: {

                                    content: {

                                        query,

                                    },

                                },

                            },

                        ],

                        filter: [

                            {

                                bool: {

                                    should: [

                                        { term: { userId } },

                                        { term: { userId: DataGateway.CORPORATE_SENTINEL } },

                                    ],

                                    minimum_should_match: 1,

                                },

                            },

                        ],

                    },

                },

                _source: { excludes: ['contentVector'] },

            },

        });



        // Combine results with weighted scoring: 70% vector + 30% BM25

        const knnHits = (knnResponse.body.hits?.hits ?? []) as unknown as Array<{ _id: string; _score: number; _source: Record<string, unknown> }>;

        const bm25Hits = (bm25Response.body.hits?.hits ?? []) as unknown as Array<{ _id: string; _score: number; _source: Record<string, unknown> }>;



        // Normalize BM25 scores to [0, 1] range

        const maxBm25Score = bm25Hits.length > 0

            ? Math.max(...bm25Hits.map((h) => h._score))

            : 1;



        // Build a map of document id → combined score

        const scoreMap = new Map<string, { score: number; hit: Record<string, unknown>; source: 'vector' | 'keyword' | 'hybrid' }>();



        // Process knn hits (scores are already in [0, 1] for cosine similarity)

        for (const hit of knnHits) {

            const docId = hit._id;

            const vectorScore = hit._score ?? 0;

            scoreMap.set(docId, {

                score: 0.7 * vectorScore,

                hit: hit._source,

                source: 'vector',

            });

        }



        // Process BM25 hits and combine

        for (const hit of bm25Hits) {

            const docId = hit._id;

            const rawBm25Score = hit._score ?? 0;

            const normalizedBm25 = maxBm25Score > 0 ? rawBm25Score / maxBm25Score : 0;

            const bm25Contribution = 0.3 * normalizedBm25;



            const existing = scoreMap.get(docId);

            if (existing) {

                // Document found in both — combine scores

                existing.score += bm25Contribution;

                existing.source = 'hybrid';

            } else {

                scoreMap.set(docId, {

                    score: bm25Contribution,

                    hit: hit._source as Record<string, unknown>,

                    source: 'keyword',

                });

            }

        }



        // Sort by combined score descending and take topK

        const sorted = [...scoreMap.entries()]

            .sort((a, b) => b[1].score - a[1].score)

            .slice(0, topK);



        // Map to SearchResult[]

        return sorted.map(([id, { score, hit, source }]) => ({

            id,

            content: (hit.content as string) ?? '',

            filename: (hit.filename as string) ?? '',

            pageNumber: (hit.pageNumber as number) ?? 0,

            chunkIndex: (hit.chunkIndex as number) ?? 0,

            score,

            source,

        }));

    }



    /**

     * Delete documents by userId, optionally filtered by filename.

     * Requirements: REQ-2.2, REQ-7.1

     */

    async deleteUserDocuments(userId: string, filename?: string): Promise<void> {

        this.assertUserId(userId);



        const indexName = this.config.openSearch.indexName;



        const filter: Record<string, unknown>[] = [{ term: { userId } }];

        if (filename) {

            filter.push({ term: { filename } });

        }



        // AOSS Serverless does not support _delete_by_query.
        // Workaround: search for matching _ids then bulk-delete.
        const sr1 = await this.openSearchClient.search({
            index: indexName, size: 1000,
            body: { query: { bool: { filter } }, _source: false },
        });
        const hits1 = ((sr1.body as unknown as { hits?: { hits?: Array<{ _id: string }> } })?.hits?.hits ?? []);
        if (hits1.length > 0) {
            await this.openSearchClient.bulk({ body: hits1.flatMap((h: { _id: string }) =>
                [{ delete: { _index: indexName, _id: h._id } }]) });
        }

    }



    /**

     * R6: List ingested URLs for a user, ordered by most recent.

     * Aggregates all chunks under the user where sourceUrl is set,

     * returning unique URLs with chunk count + most recent uploadedAt.

     */

    async listIngestedUrls(userId: string, limit: number = 20): Promise<Array<{

        url: string;

        filename: string;

        chunkCount: number;

        uploadedAt: string;

    }>> {

        this.assertUserId(userId);

        const indexName = this.config.openSearch.indexName;



        const result = await this.openSearchClient.search({

            index: indexName,

            body: {

                size: 0,

                query: {

                    bool: {

                        filter: [

                            { term: { userId } },

                            { exists: { field: 'sourceUrl' } },

                        ],

                    },

                },

                aggs: {

                    by_url: {

                        terms: { field: 'sourceUrl', size: Math.max(1, Math.min(limit, 100)) },

                        aggs: {

                            latest: { max: { field: 'uploadedAt' } },

                            sample: {

                                top_hits: {

                                    size: 1,

                                    _source: ['filename', 'uploadedAt', 'sourceUrl'],

                                    sort: [{ uploadedAt: { order: 'desc' } }],

                                },

                            },

                        },

                    },

                },

            },

        });



        type Bucket = {

            key: string;

            doc_count: number;

            latest?: { value_as_string?: string; value?: number };

            sample?: { hits?: { hits?: Array<{ _source?: { filename?: string; uploadedAt?: string } }> } };

        };

        const r = result as { body?: { aggregations?: { by_url?: { buckets?: Bucket[] } } }; aggregations?: { by_url?: { buckets?: Bucket[] } } };

        const body = r.body ?? r;

        const buckets: Bucket[] = body.aggregations?.by_url?.buckets ?? [];

        return buckets

            .map((b) => {

                const sample = b.sample?.hits?.hits?.[0]?._source ?? {};

                const uploadedAt = b.latest?.value_as_string

                    ?? sample.uploadedAt

                    ?? new Date(b.latest?.value ?? Date.now()).toISOString();

                return {

                    url: b.key,

                    filename: sample.filename ?? b.key,

                    chunkCount: b.doc_count,

                    uploadedAt,

                };

            })

            .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

    }



    /**

     * R6: Remove all chunks for a single ingested URL belonging to userId.

     * Returns the count of chunks deleted.

     */

    async deleteIngestedUrl(userId: string, url: string): Promise<number> {

        this.assertUserId(userId);

        if (!url || typeof url !== 'string') {

            throw new Error('DataGateway.deleteIngestedUrl: url is required');

        }

        const indexName = this.config.openSearch.indexName;

        // AOSS Serverless does not support _delete_by_query.
        // Workaround: search for matching _ids then bulk-delete.
        const sr2 = await this.openSearchClient.search({
            index: indexName, size: 1000,
            body: { query: { bool: { filter: [{ term: { userId } }, { term: { sourceUrl: url } }] } }, _source: false },
        });
        const hits2 = ((sr2.body as unknown as { hits?: { hits?: Array<{ _id: string }> } })?.hits?.hits ?? []);
        if (hits2.length === 0) return 0;
        await this.openSearchClient.bulk({ body: hits2.flatMap((h: { _id: string }) =>
            [{ delete: { _index: indexName, _id: h._id } }]) });
        return hits2.length;
    }



    // ── S3 operations ──



    /**

     * Upload a file to S3 with userId prefix enforcement and SSE-S3 encryption.

     * Uses multipart upload (via @aws-sdk/lib-storage) for files > 5MB,

     * PutObjectCommand for smaller files.

     *

     * @param userId - The user performing the upload

     * @param bucket - S3 bucket name (ignored — uses config.s3.dataBucket)

     * @param key - Object key — MUST start with `{userId}/`

     * @param stream - ReadableStream of file content

     * @returns The S3 key of the uploaded object

     */

    async uploadFile(userId: string, _bucket: string, key: string, stream: ReadableStream): Promise<string> {

        this.assertUserId(userId);

        this.assertKeyBelongsToUser(userId, key);



        const targetBucket = this.config.s3.dataBucket;



        // Convert web ReadableStream to Node.js Readable for AWS SDK compatibility

        const nodeStream = Readable.fromWeb(stream as import('node:stream/web').ReadableStream);



        // Collect the stream into a buffer to determine size for upload strategy

        const chunks: Buffer[] = [];

        for await (const chunk of nodeStream) {

            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

        }

        const body = Buffer.concat(chunks);



        const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5MB



        if (body.length > MULTIPART_THRESHOLD) {

            // Use multipart upload for large files

            const upload = new Upload({

                client: this.s3Client,

                params: {

                    Bucket: targetBucket,

                    Key: key,

                    Body: body,

                    ServerSideEncryption: 'AES256',

                },

            });

            await upload.done();

        } else {

            // Use simple PutObject for small files

            await this.s3Client.send(

                new PutObjectCommand({

                    Bucket: targetBucket,

                    Key: key,

                    Body: body,

                    ServerSideEncryption: 'AES256',

                }),

            );

        }



        return key;

    }



    /**

     * Download a file from S3 with userId prefix validation.

     *

     * @param userId - The user requesting the file

     * @param bucket - S3 bucket name (ignored — uses config.s3.dataBucket)

     * @param key - Object key — MUST start with `{userId}/`

     * @returns ReadableStream of the file content

     */

    async getFile(userId: string, _bucket: string, key: string): Promise<ReadableStream> {

        this.assertUserId(userId);

        this.assertKeyBelongsToUser(userId, key, 'read');



        const targetBucket = this.config.s3.dataBucket;



        const response = await this.s3Client.send(

            new GetObjectCommand({

                Bucket: targetBucket,

                Key: key,

            }),

        );



        if (!response.Body) {

            throw new Error(`DataGateway: file not found at key "${key}"`);

        }



        // The AWS SDK v3 returns a SdkStreamMixin which provides transformToWebStream()

        // Use this as the primary conversion path for consistent ReadableStream interface

        const body = response.Body;

        if ('transformToWebStream' in body && typeof body.transformToWebStream === 'function') {

            return body.transformToWebStream() as unknown as ReadableStream;

        }

        // If it's a Node.js Readable stream, convert to web ReadableStream

        if (body instanceof Readable || (typeof (body as unknown as NodeJS.ReadableStream).pipe === 'function')) {

            return Readable.toWeb(body as unknown as Readable) as unknown as ReadableStream;

        }



        throw new Error('DataGateway: unexpected response body type from S3');

    }



    /**

     * List files under a userId prefix in S3.

     *

     * @param userId - The user whose files to list

     * @param prefix - Additional prefix within the user's namespace (e.g., "documents/")

     * @returns Array of FileMetadata for matching objects

     */

    async listFiles(userId: string, prefix: string): Promise<FileMetadata[]> {

        this.assertUserId(userId);



        const targetBucket = this.config.s3.dataBucket;

        const fullPrefix = `${userId}/${prefix}`;



        const results: FileMetadata[] = [];

        let continuationToken: string | undefined;



        do {

            const response = await this.s3Client.send(

                new ListObjectsV2Command({

                    Bucket: targetBucket,

                    Prefix: fullPrefix,

                    ContinuationToken: continuationToken,

                }),

            );



            if (response.Contents) {

                for (const obj of response.Contents) {

                    if (obj.Key) {

                        results.push({

                            key: obj.Key,

                            size: obj.Size ?? 0,

                            lastModified: obj.LastModified?.toISOString() ?? new Date().toISOString(),

                        });

                    }

                }

            }



            continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;

        } while (continuationToken);



        return results;

    }



    /**

     * Delete a file from S3 with userId prefix validation.

     *

     * @param userId - The user requesting deletion

     * @param bucket - S3 bucket name (ignored — uses config.s3.dataBucket)

     * @param key - Object key — MUST start with `{userId}/`

     */

    async deleteFile(userId: string, _bucket: string, key: string): Promise<void> {

        this.assertUserId(userId);

        this.assertKeyBelongsToUser(userId, key);



        const targetBucket = this.config.s3.dataBucket;



        await this.s3Client.send(

            new DeleteObjectCommand({

                Bucket: targetBucket,

                Key: key,

            }),

        );

    }



    // ── Audit & PDPA ──



    /**

     * Write a structured audit log entry to stdout (CloudWatch agent picks up stdout).

     * Includes: userId, operation, resource, timestamp (ISO 8601), success.

     * Requirements: REQ-7.1

     */

    logAccess(userId: string, operation: string, resource: string): void {

        this.assertUserId(userId);



        const entry: AuditLogEntry = {

            userId,

            operation,

            resource,

            timestamp: new Date().toISOString(),

            success: true,

        };



        // Structured JSON log — CloudWatch agent picks up stdout

        console.log(JSON.stringify(entry));

    }



    /**

     * Gather ALL user data from DynamoDB, OpenSearch, and S3 for PDPA export.

     * Requirements: REQ-7.3

     */

    async exportUserData(userId: string): Promise<UserDataExport> {

        this.assertUserId(userId);



        // 1. Get all chat messages (paginate through all pages)

        const allMessages: ChatMessage[] = [];

        let lastKey: Record<string, unknown> | undefined;

        do {

            const page = await this.getChatHistoryPaginated(userId, 100, lastKey);

            allMessages.push(...page.messages);

            lastKey = page.lastEvaluatedKey;

        } while (lastKey);



        // 2. Get user preferences

        const preferences = await this.getUserPreference(userId);



        // 3. Get all indexed documents from OpenSearch

        const documents = await this.getAllUserDocuments(userId);



        // 4. Get all files from S3

        const files = await this.listFiles(userId, '');



        return {

            userId,

            exportedAt: new Date().toISOString(),

            chatMessages: allMessages,

            preferences,

            documents,

            files,

        };

    }



    /**

     * Delete ALL user data from DynamoDB, OpenSearch, and S3.

     * Returns a DeletionReceipt with counts of deleted items.

     * Requirements: REQ-7.3

     */

    async deleteAllUserData(userId: string): Promise<DeletionReceipt> {

        this.assertUserId(userId);



        let dynamoDbRecordsDeleted = 0;



        // 1. Delete all chat messages from DynamoDB (query all, then delete each)

        let lastKey: Record<string, unknown> | undefined;

        do {

            const page = await this.getChatHistoryPaginated(userId, 100, lastKey);

            for (const msg of page.messages) {

                await this.dynamoClient.send(new DeleteCommand({

                    TableName: this.config.dynamoDb.chatMessagesTable,

                    Key: { userId, timestamp: msg.timestamp },

                }));

                dynamoDbRecordsDeleted++;

            }

            lastKey = page.lastEvaluatedKey;

        } while (lastKey);



        // 2. Delete user preferences from DynamoDB

        const prefs = await this.getUserPreference(userId);

        if (prefs) {

            await this.dynamoClient.send(new DeleteCommand({

                TableName: this.config.dynamoDb.userPreferencesTable,

                Key: { userId },

            }));

            dynamoDbRecordsDeleted++;

        }



        // 3. Delete all documents from OpenSearch

        const documents = await this.getAllUserDocuments(userId);

        const openSearchDocumentsDeleted = documents.length;

        await this.deleteUserDocuments(userId);



        // 4. Delete all files from S3

        const files = await this.listFiles(userId, '');

        for (const file of files) {

            await this.s3Client.send(

                new DeleteObjectCommand({

                    Bucket: this.config.s3.dataBucket,

                    Key: file.key,

                }),

            );

        }

        const s3ObjectsDeleted = files.length;



        return {

            userId,

            deletedAt: new Date().toISOString(),

            dynamoDbRecordsDeleted,

            openSearchDocumentsDeleted,

            s3ObjectsDeleted,

        };

    }



    // ── Private helpers for PDPA ──



    /**

     * Retrieve all documents for a user from OpenSearch (scroll through all results).

     */

    private async getAllUserDocuments(userId: string): Promise<DocumentChunk[]> {

        const indexName = this.config.openSearch.indexName;

        const documents: DocumentChunk[] = [];

        const pageSize = 100;

        let from = 0;



        // eslint-disable-next-line no-constant-condition

        while (true) {

            const response = await this.openSearchClient.search({

                index: indexName,

                body: {

                    size: pageSize,

                    from,

                    query: {

                        bool: {

                            filter: [{ term: { userId } }],

                        },

                    },

                },

            });



            const hits = (response.body.hits?.hits ?? []) as unknown as Array<{

                _source: Record<string, unknown>;

            }>;



            if (hits.length === 0) {

                break;

            }



            for (const hit of hits) {

                const src = hit._source;

                documents.push({

                    id: src.id as string,

                    docType: src.docType as string,

                    content: src.content as string,

                    contentVector: src.contentVector as number[],

                    filename: src.filename as string,

                    pageNumber: src.pageNumber as number,

                    chunkIndex: src.chunkIndex as number,

                    uploadedAt: src.uploadedAt as string,

                });

            }



            from += pageSize;

            if (hits.length < pageSize) {

                break;

            }

        }



        return documents;

    }



    // ── Private helpers ──



    /**

     * R8: Upload a generated draft (.docx, .pptx, .txt, ...) and return a

     * presigned GET URL valid for 1 hour. Stored under `{userId}/drafts/<filename>`.

     */

    async uploadDraft(userId: string, filename: string, content: Buffer | Uint8Array, contentType: string): Promise<{ key: string; url: string; bucket: string; expiresInSec: number }> {

        this.assertUserId(userId);

        if (!filename || /[\\/]/.test(filename) || filename.includes('..')) {

            throw new Error('DataGateway.uploadDraft: invalid filename');

        }

        const key = `${userId}/drafts/${filename}`;

        this.assertKeyBelongsToUser(userId, key, 'write');

        const targetBucket = this.config.s3.dataBucket;

        await this.s3Client.send(new PutObjectCommand({

            Bucket: targetBucket,

            Key: key,

            Body: content,

            ContentType: contentType,

            ServerSideEncryption: 'AES256',

        }));

        const expiresInSec = 3600;

        // Cast: presigner uses a slightly newer @smithy/types so the structural

        // S3Client check fails despite identical runtime shape.

        const url = await getSignedUrl(this.s3Client as unknown as Parameters<typeof getSignedUrl>[0], new GetObjectCommand({

            Bucket: targetBucket,

            Key: key,

        }) as unknown as Parameters<typeof getSignedUrl>[1], { expiresIn: expiresInSec });

        return { key, url, bucket: targetBucket, expiresInSec };

    }



    /**

     * Validates that a userId is provided and non-empty.

     * This is the core isolation enforcement — every public method calls this

     * before performing any operation.

     */

    private assertUserId(userId: string): void {

        if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {

            throw new Error('DataGateway: userId is required for all operations (data isolation enforcement)');

        }

        if (userId === DataGateway.CORPORATE_SENTINEL) {

            throw new Error('DataGateway: CORPORATE sentinel cannot be used as a regular userId (data isolation enforcement)');

        }

    }



    /**

     * Validates that an S3 key belongs to the given userId.

     * The key MUST start with `{userId}/` and MUST NOT contain path traversal sequences.

     * This prevents cross-user data access via crafted keys.

     */

    private assertKeyBelongsToUser(userId: string, key: string, mode: 'read' | 'write' = 'write'): void {

        // Reject path traversal attempts (always)

        if (key.includes('../') || key.includes('..\\')) {

            throw new Error('DataGateway: path traversal detected in key (data isolation enforcement)');

        }



        // Enforce userId prefix; in read mode also allow `corporate/` for shared docs.

        const expectedPrefix = `${userId}/`;

        const corporatePrefix = 'corporate/';

        const startsWithUser = key.startsWith(expectedPrefix);

        const startsWithCorporate = key.startsWith(corporatePrefix);



        if (mode === 'read') {

            if (!startsWithUser && !startsWithCorporate) {

                throw new Error(

                    `DataGateway: key "${key}" does not start with userId prefix "${expectedPrefix}" or corporate prefix "${corporatePrefix}" (data isolation enforcement)`,

                );

            }

            return;

        }



        // write mode: only userId prefix allowed (regular users cannot write to corporate/).

        if (!startsWithUser) {

            throw new Error(

                `DataGateway: key "${key}" does not start with userId prefix "${expectedPrefix}" (data isolation enforcement)`,

            );

        }

    }

}

