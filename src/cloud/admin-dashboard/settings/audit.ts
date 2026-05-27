/**
 * Audit logger for admin dashboard settings changes.
 *
 * Writes structured JSON log entries to the settings audit log file.
 * Each entry records who changed what, with old and new values for
 * only the fields that were actually modified.
 *
 * Design principles:
 * - Non-blocking: failures never prevent the settings save from completing
 * - Structured: entries are JSON for easy parsing and querying
 * - Minimal: only modified fields are logged, not the entire payload
 *
 * Requirements: 6.1, 6.2, 6.3
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { envPath } from '../../../modules/paths.js';

// ── Types ──

/** A single audit log entry for a settings change. */
export interface AuditEntry {
    /** ISO 8601 timestamp of the change */
    timestamp: string;
    /** The admin username who made the change */
    username: string;
    /** List of setting keys that were modified */
    changedFields: string[];
    /** Previous values for the changed fields */
    oldValues: Record<string, string>;
    /** New values for the changed fields */
    newValues: Record<string, string>;
}

// ── Constants ──

const LOG_PATH = envPath('LOG_PATH', 'logs');
const SETTINGS_AUDIT_LOG = path.join(LOG_PATH, 'settings-audit.log');

// ── Public API ──

/**
 * Log a settings change to the audit log file.
 *
 * Writes a structured JSON entry containing only the fields that were
 * actually modified. If the write fails, logs the error to console but
 * does NOT throw or block the calling operation.
 *
 * @param username - The admin who made the change
 * @param changedFields - List of setting keys that were modified
 * @param oldValues - Previous values for changed fields
 * @param newValues - New values for changed fields
 */
export async function logSettingsChange(
    username: string,
    changedFields: string[],
    oldValues: Record<string, string>,
    newValues: Record<string, string>,
): Promise<void> {
    try {
        // Only include values for fields that actually changed
        const filteredOld: Record<string, string> = {};
        const filteredNew: Record<string, string> = {};

        for (const field of changedFields) {
            if (field in oldValues) filteredOld[field] = oldValues[field];
            if (field in newValues) filteredNew[field] = newValues[field];
        }

        const entry: AuditEntry = {
            timestamp: new Date().toISOString(),
            username,
            changedFields,
            oldValues: filteredOld,
            newValues: filteredNew,
        };

        await fs.mkdir(path.dirname(SETTINGS_AUDIT_LOG), { recursive: true });
        await fs.appendFile(
            SETTINGS_AUDIT_LOG,
            JSON.stringify(entry) + '\n',
            'utf8',
        );
    } catch (err) {
        // Best effort — audit log failure must never block the save operation
        console.error('[audit] Failed to write settings audit log:', (err as Error).message);
    }
}

/**
 * Read the settings audit log and return parsed entries in reverse
 * chronological order (most recent first).
 *
 * Each entry includes: username, timestamp, changedFields, oldValues, newValues.
 *
 * Returns an empty array if the log file does not exist or cannot be read.
 */
export async function getChangeHistory(): Promise<AuditEntry[]> {
    try {
        const content = await fs.readFile(SETTINGS_AUDIT_LOG, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);

        const entries: AuditEntry[] = [];
        for (const line of lines) {
            try {
                const entry = JSON.parse(line) as AuditEntry;
                entries.push(entry);
            } catch {
                // Skip malformed lines — don't let one bad entry break history
            }
        }

        // Reverse chronological order (most recent first)
        return entries.reverse();
    } catch (err) {
        // File doesn't exist or can't be read — return empty history
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('[audit] Failed to read settings audit log:', (err as Error).message);
        }
        return [];
    }
}

/**
 * Get the path to the settings audit log file.
 * Exposed for testing purposes.
 */
export function getAuditLogPath(): string {
    return SETTINGS_AUDIT_LOG;
}
