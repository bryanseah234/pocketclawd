/**
 * Unit tests for the settings audit logger.
 *
 * Requirements: 6.1, 6.2, 6.3
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const __test_dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_LOG_DIR = path.join(__test_dirname, '__test_logs__');

// Mock envPath before importing the module under test
vi.mock('../../../modules/paths.js', async () => {
    const nodePath = await import('node:path');
    const { fileURLToPath: toPath } = await import('node:url');
    const dir = nodePath.dirname(toPath(import.meta.url));
    return {
        envPath: (_envVar: string, _defaultSubdir: string) =>
            nodePath.join(dir, '__test_logs__'),
    };
});

// Dynamic import after mock is established
const { logSettingsChange, getChangeHistory, getAuditLogPath } = await import('./audit.js');

describe('audit logger', () => {
    beforeEach(async () => {
        await fs.rm(TEST_LOG_DIR, { recursive: true, force: true });
        await fs.mkdir(TEST_LOG_DIR, { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(TEST_LOG_DIR, { recursive: true, force: true });
    });

    describe('logSettingsChange', () => {
        it('writes a structured JSON entry to the audit log', async () => {
            await logSettingsChange(
                'admin_user',
                ['cron.ingest_schedule'],
                { 'cron.ingest_schedule': '0 2 * * *' },
                { 'cron.ingest_schedule': '0 3 * * *' },
            );

            const logPath = getAuditLogPath();
            const content = await fs.readFile(logPath, 'utf8');
            const entry = JSON.parse(content.trim());

            expect(entry.username).toBe('admin_user');
            expect(entry.changedFields).toEqual(['cron.ingest_schedule']);
            expect(entry.oldValues).toEqual({ 'cron.ingest_schedule': '0 2 * * *' });
            expect(entry.newValues).toEqual({ 'cron.ingest_schedule': '0 3 * * *' });
            expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });

        it('logs only the modified fields, not extra keys in oldValues/newValues', async () => {
            await logSettingsChange(
                'admin',
                ['chat.archive_mode'],
                { 'chat.archive_mode': 'off', 'cron.ingest_schedule': '0 2 * * *' },
                { 'chat.archive_mode': 'self', 'cron.ingest_schedule': '0 2 * * *' },
            );

            const logPath = getAuditLogPath();
            const content = await fs.readFile(logPath, 'utf8');
            const entry = JSON.parse(content.trim());

            // Only the changed field should be in the logged values
            expect(entry.changedFields).toEqual(['chat.archive_mode']);
            expect(entry.oldValues).toEqual({ 'chat.archive_mode': 'off' });
            expect(entry.newValues).toEqual({ 'chat.archive_mode': 'self' });
        });

        it('handles multiple changed fields in a single entry', async () => {
            await logSettingsChange(
                'admin',
                ['cron.ingest_schedule', 'chat.archive_mode'],
                { 'cron.ingest_schedule': '0 2 * * *', 'chat.archive_mode': 'off' },
                { 'cron.ingest_schedule': '0 4 * * *', 'chat.archive_mode': 'all' },
            );

            const logPath = getAuditLogPath();
            const content = await fs.readFile(logPath, 'utf8');
            const entry = JSON.parse(content.trim());

            expect(entry.changedFields).toHaveLength(2);
            expect(entry.oldValues['cron.ingest_schedule']).toBe('0 2 * * *');
            expect(entry.newValues['cron.ingest_schedule']).toBe('0 4 * * *');
            expect(entry.oldValues['chat.archive_mode']).toBe('off');
            expect(entry.newValues['chat.archive_mode']).toBe('all');
        });

        it('does not throw when the write fails', async () => {
            // Remove the log directory and create a file at its path to force mkdir/appendFile to fail
            const logPath = getAuditLogPath();
            const logDir = path.dirname(logPath);
            await fs.rm(logDir, { recursive: true, force: true });
            // Create a file where the directory should be — causes mkdir to fail
            await fs.mkdir(path.dirname(logDir), { recursive: true });
            await fs.writeFile(logDir, 'blocker', 'utf8');

            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

            // Should not throw even when the write fails
            await expect(
                logSettingsChange('admin', ['key'], { key: 'old' }, { key: 'new' }),
            ).resolves.toBeUndefined();

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('[audit] Failed to write settings audit log:'),
                expect.any(String),
            );

            consoleSpy.mockRestore();
            // Clean up the blocker file so afterEach can remove the directory
            await fs.rm(logDir, { force: true });
        });

        it('appends multiple entries to the same log file', async () => {
            await logSettingsChange('admin1', ['key1'], { key1: 'a' }, { key1: 'b' });
            await logSettingsChange('admin2', ['key2'], { key2: 'c' }, { key2: 'd' });

            const logPath = getAuditLogPath();
            const content = await fs.readFile(logPath, 'utf8');
            const lines = content.trim().split('\n');

            expect(lines).toHaveLength(2);
            expect(JSON.parse(lines[0]).username).toBe('admin1');
            expect(JSON.parse(lines[1]).username).toBe('admin2');
        });
    });

    describe('getChangeHistory', () => {
        it('returns entries in reverse chronological order', async () => {
            await logSettingsChange('admin1', ['key1'], { key1: 'a' }, { key1: 'b' });
            await new Promise((r) => setTimeout(r, 10));
            await logSettingsChange('admin2', ['key2'], { key2: 'c' }, { key2: 'd' });

            const history = await getChangeHistory();

            expect(history).toHaveLength(2);
            // Most recent first
            expect(history[0].username).toBe('admin2');
            expect(history[1].username).toBe('admin1');
        });

        it('returns empty array when log file does not exist', async () => {
            await fs.rm(TEST_LOG_DIR, { recursive: true, force: true });

            const history = await getChangeHistory();
            expect(history).toEqual([]);
        });

        it('skips malformed lines without breaking', async () => {
            const logPath = getAuditLogPath();
            await fs.writeFile(
                logPath,
                '{"timestamp":"2024-01-01T00:00:00Z","username":"admin","changedFields":["k"],"oldValues":{"k":"a"},"newValues":{"k":"b"}}\n' +
                'not valid json\n' +
                '{"timestamp":"2024-01-02T00:00:00Z","username":"admin2","changedFields":["k2"],"oldValues":{"k2":"c"},"newValues":{"k2":"d"}}\n',
                'utf8',
            );

            const history = await getChangeHistory();

            expect(history).toHaveLength(2);
            // Reverse order — second valid entry first
            expect(history[0].username).toBe('admin2');
            expect(history[1].username).toBe('admin');
        });

        it('returns entries with correct structure', async () => {
            await logSettingsChange(
                'test_admin',
                ['notifications.digest_timezone'],
                { 'notifications.digest_timezone': 'Asia/Singapore' },
                { 'notifications.digest_timezone': 'America/New_York' },
            );

            const history = await getChangeHistory();

            expect(history).toHaveLength(1);
            const entry = history[0];
            expect(entry).toHaveProperty('timestamp');
            expect(entry).toHaveProperty('username', 'test_admin');
            expect(entry).toHaveProperty('changedFields', ['notifications.digest_timezone']);
            expect(entry).toHaveProperty('oldValues');
            expect(entry).toHaveProperty('newValues');
            expect(entry.oldValues['notifications.digest_timezone']).toBe('Asia/Singapore');
            expect(entry.newValues['notifications.digest_timezone']).toBe('America/New_York');
        });
    });
});
