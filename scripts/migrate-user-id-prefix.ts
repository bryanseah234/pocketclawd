#!/usr/bin/env node
/**
 * migrate-user-id-prefix.ts
 *
 * Migrates userId keys from legacy bare-phone format (e.g. "447912345678")
 * to the new prefixed format ("wa:447912345678" / "tg:123456789").
 *
 * Since there are no production users yet, this script TRUNCATES the
 * DynamoDB user-data tables and the local SQLite users/sessions tables
 * so the system starts clean with the new prefix scheme on first use.
 *
 * SAFE TO RUN: no message history is preserved (testing-only deployment).
 *
 * Usage: pnpm exec tsx scripts/migrate-user-id-prefix.ts [--dry-run]
 */

import { DynamoDBClient, ScanCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const DRY_RUN = process.argv.includes('--dry-run');
const REGION = process.env.AWS_REGION || 'ap-southeast-1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'v2.db');

async function truncateDynamoTable(client: DynamoDBClient, table: string, keyName: string): Promise<number> {
    console.log(`\nScanning ${table}...`);
    let count = 0;
    let lastKey: Record<string, unknown> | undefined;

    do {
        const resp = await client.send(new ScanCommand({
            TableName: table,
            ExclusiveStartKey: lastKey as any,
            ProjectionExpression: keyName,
        }));
        const items = resp.Items ?? [];
        console.log(`  Found ${items.length} items`);

        for (const item of items) {
            const row = unmarshall(item);
            const key = row[keyName];
            console.log(`  ${DRY_RUN ? '[DRY]' : 'DELETE'} ${table}/${key}`);
            if (!DRY_RUN) {
                await client.send(new DeleteItemCommand({
                    TableName: table,
                    Key: { [keyName]: item[keyName] },
                }));
            }
            count++;
        }
        lastKey = resp.LastEvaluatedKey as any;
    } while (lastKey);

    return count;
}

async function main() {
    console.log(`migrate-user-id-prefix ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
    console.log('Purpose: reset userId-keyed data so new wa:/tg: prefix scheme starts clean.\n');

    // ── DynamoDB ──────────────────────────────────────────────────────────────
    const dynamo = new DynamoDBClient({ region: REGION });

    const tables: Array<{ name: string; key: string }> = [
        { name: 'nanoclaw-chat-messages',    key: 'userId' },
        { name: 'nanoclaw-user-preferences', key: 'userId' },
    ];

    let total = 0;
    for (const { name, key } of tables) {
        try {
            const n = await truncateDynamoTable(dynamo, name, key);
            total += n;
            console.log(`  → ${n} rows deleted from ${name}`);
        } catch (err) {
            console.warn(`  WARN: could not clear ${name}: ${(err as Error).message}`);
        }
    }

    // ── SQLite (local NanoClaw v2 DB) ─────────────────────────────────────────
    try {
        const db = new Database(DB_PATH);
        const tables_sql = ['users', 'user_roles', 'agent_group_members', 'user_dms',
                            'dropped_messages', 'pending_approvals', 'sessions'];
        for (const tbl of tables_sql) {
            const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tbl);
            if (!exists) continue;
            if (!DRY_RUN) {
                const info = db.prepare(`DELETE FROM ${tbl}`).run();
                console.log(`SQLite: deleted ${info.changes} rows from ${tbl}`);
            } else {
                const { count } = db.prepare(`SELECT count(*) as count FROM ${tbl}`).get() as { count: number };
                console.log(`SQLite [DRY]: ${count} rows in ${tbl}`);
            }
        }
        db.close();
    } catch (err) {
        console.warn(`SQLite migration skipped: ${(err as Error).message}`);
    }

    console.log(`\n✅ Migration complete. ${DRY_RUN ? '(dry run — nothing deleted)' : `${total} DynamoDB items deleted.`}`);
    console.log('New userId scheme: WhatsApp → wa:<phone>, Telegram → tg:<chat_id>');
}

main().catch((err) => { console.error(err); process.exit(1); });
