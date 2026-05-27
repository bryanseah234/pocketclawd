/**
 * Settings API Route Handler — HTTP endpoints for the admin settings panel.
 *
 * Mounts under `/admin/api/settings` and delegates to SettingsManager for
 * business logic. Follows the same routing pattern as the parent admin
 * dashboard handler (path matching + sendJson helpers).
 *
 * Endpoints:
 * - GET  /admin/api/settings          → all settings grouped by category
 * - PUT  /admin/api/settings          → bulk update settings (key→value map)
 * - POST /admin/api/settings/apply    → persist + trigger graceful restart
 * - POST /admin/api/settings/reset/:key → reset a single setting to default
 * - POST /admin/api/settings/export   → export all DB overrides as JSON
 * - POST /admin/api/settings/import   → bulk import settings from JSON
 * - GET  /admin/api/settings/history  → audit log entries (reverse chronological)
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 2.7
 */

import http from 'node:http';

import { log } from '../../../log.js';

import type { SettingsManager } from './settings-manager.js';
import { getDefinition, isRegisteredKey } from './schema.js';
import { validateValue } from './validator.js';

// ── Types ──

export interface SettingsRoutesDeps {
    /** The SettingsManager instance to delegate business logic to. */
    manager: SettingsManager;
    /** Optional: function to trigger a graceful orchestrator restart. */
    triggerRestart?: () => Promise<{ success: boolean; message: string }>;
}

// ── Helpers ──

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(data));
}

/**
 * Read the full request body as a UTF-8 string.
 * Rejects if the body exceeds maxBytes (default 1MB).
 */
function readBody(req: http.IncomingMessage, maxBytes = 1_048_576): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let totalSize = 0;

        req.on('data', (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > maxBytes) {
                req.destroy();
                reject(new Error('Request body too large'));
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf-8'));
        });

        req.on('error', reject);
    });
}

/**
 * Parse a JSON body from the request. Returns the parsed object or sends
 * a 400 error response and returns null.
 */
async function parseJsonBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<Record<string, unknown> | null> {
    let raw: string;
    try {
        raw = await readBody(req);
    } catch (_err) {
        sendJson(res, { error: 'Request body too large' }, 400);
        return null;
    }

    if (!raw.trim()) {
        sendJson(res, { error: 'Request body is empty' }, 400);
        return null;
    }

    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            sendJson(res, { error: 'Request body must be a JSON object' }, 400);
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch {
        sendJson(res, { error: 'Invalid JSON in request body' }, 400);
        return null;
    }
}

// ── Route Handler Factory ──

/**
 * Creates the settings route handler function.
 *
 * The returned handler follows the admin dashboard convention:
 * - Returns `true` if the request was handled
 * - Returns `false` if the URL doesn't match (pass-through to other routes)
 *
 * Auth is handled by the parent `handleAdminRequest` — this handler is only
 * called for already-authenticated requests.
 */
export function createSettingsRoutes(deps: SettingsRoutesDeps) {
    const { manager, triggerRestart } = deps;

    return async function handleSettingsRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ): Promise<boolean> {
        const url = req.url || '';
        const method = req.method || 'GET';

        // Parse URL to get clean path
        const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
        const path = parsedUrl.pathname;

        // Only handle /admin/api/settings routes
        if (!path.startsWith('/admin/api/settings')) return false;

        try {
            // ── GET /admin/api/settings ──
            // Returns all settings grouped by category with current values and metadata.
            if (path === '/admin/api/settings' && method === 'GET') {
                const categories = manager.getAllSettings();
                sendJson(res, { categories });
                return true;
            }

            // ── PUT /admin/api/settings ──
            // Bulk update: body is { "key": "value", ... }
            // Validates each entry and returns field-level errors for failures.
            if (path === '/admin/api/settings' && method === 'PUT') {
                const body = await parseJsonBody(req, res);
                if (body === null) return true; // error already sent

                const errors: Array<{ key: string; message: string }> = [];
                const updated: Array<{ key: string; value: string; requiresRestart: boolean }> = [];

                for (const [key, rawValue] of Object.entries(body)) {
                    // Coerce value to string
                    const value = String(rawValue);

                    // Check if key is registered
                    if (!isRegisteredKey(key)) {
                        errors.push({ key, message: 'Unknown setting' });
                        continue;
                    }

                    // Validate value against schema
                    const definition = getDefinition(key)!;
                    const validation = validateValue(definition, value);
                    if (!validation.valid) {
                        errors.push({ key, message: validation.message });
                        continue;
                    }

                    // Persist the setting
                    try {
                        const result = manager.updateSetting(key, value, 'admin');
                        updated.push({
                            key,
                            value,
                            requiresRestart: result.requiresRestart,
                        });
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : 'Failed to update setting';
                        errors.push({ key, message: msg });
                    }
                }

                // If there are any errors, return 400 with both errors and any successful updates
                if (errors.length > 0) {
                    sendJson(res, { errors, updated }, 400);
                    return true;
                }

                sendJson(res, { updated });
                return true;
            }

            // ── POST /admin/api/settings/apply ──
            // Persist settings and trigger graceful orchestrator restart.
            if (path === '/admin/api/settings/apply' && method === 'POST') {
                // Optionally accept a body with settings to save before restart
                const contentType = req.headers['content-type'] || '';
                if (contentType.includes('application/json')) {
                    const body = await parseJsonBody(req, res);
                    if (body === null) return true;

                    // Apply settings first (same logic as PUT)
                    const errors: Array<{ key: string; message: string }> = [];
                    for (const [key, rawValue] of Object.entries(body)) {
                        const value = String(rawValue);
                        if (!isRegisteredKey(key)) {
                            errors.push({ key, message: 'Unknown setting' });
                            continue;
                        }
                        const definition = getDefinition(key)!;
                        const validation = validateValue(definition, value);
                        if (!validation.valid) {
                            errors.push({ key, message: validation.message });
                            continue;
                        }
                        try {
                            manager.updateSetting(key, value, 'admin');
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : 'Failed to update setting';
                            errors.push({ key, message: msg });
                        }
                    }

                    if (errors.length > 0) {
                        sendJson(res, { error: 'Validation failed', errors }, 400);
                        return true;
                    }
                }

                // Trigger restart
                if (triggerRestart) {
                    try {
                        const result = await triggerRestart();
                        if (!result.success) {
                            sendJson(res, { error: result.message }, 500);
                            return true;
                        }
                        sendJson(res, { success: true, message: result.message });
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : 'Restart failed';
                        log.error('Settings apply restart failed', { err });
                        sendJson(res, { error: msg }, 500);
                    }
                } else {
                    // No restart handler configured — just confirm settings were saved
                    sendJson(res, {
                        success: true,
                        message: 'Settings saved. Restart handler not configured.',
                    });
                }

                return true;
            }

            // ── POST /admin/api/settings/reset/:key ──
            // Reset a single setting to its default (delete DB override).
            const resetMatch = path.match(/^\/admin\/api\/settings\/reset\/(.+)$/);
            if (resetMatch && method === 'POST') {
                const key = decodeURIComponent(resetMatch[1]);

                if (!isRegisteredKey(key)) {
                    sendJson(res, { error: 'Unknown setting', key }, 404);
                    return true;
                }

                try {
                    const result = manager.resetSetting(key);
                    sendJson(res, {
                        key,
                        previousValue: result.previousValue,
                        newValue: result.newValue,
                        source: result.source,
                    });
                } catch (err) {
                    const msg = err instanceof Error ? err.message : 'Failed to reset setting';
                    log.error('Settings reset failed', { key, err });
                    sendJson(res, { error: msg }, 500);
                }

                return true;
            }

            // ── POST /admin/api/settings/export ──
            // Export all DB overrides as a JSON key→value map.
            if (path === '/admin/api/settings/export' && method === 'POST') {
                const overrides = manager.exportOverrides();
                sendJson(res, { settings: overrides });
                return true;
            }

            // ── POST /admin/api/settings/import ──
            // Bulk import settings from a JSON key→value map.
            if (path === '/admin/api/settings/import' && method === 'POST') {
                const body = await parseJsonBody(req, res);
                if (body === null) return true;

                // Validate that all values are strings
                const settingsMap: Record<string, string> = {};
                for (const [key, value] of Object.entries(body)) {
                    settingsMap[key] = String(value);
                }

                const result = manager.importSettings(settingsMap, 'import');
                sendJson(res, result);
                return true;
            }

            // ── GET /admin/api/settings/history ──
            // Returns audit log entries in reverse chronological order.
            if (path === '/admin/api/settings/history' && method === 'GET') {
                const { getChangeHistory } = await import('./audit.js');
                const history = await getChangeHistory();
                sendJson(res, { history });
                return true;
            }

            // URL starts with /admin/api/settings but doesn't match any route
            sendJson(res, { error: 'Not found' }, 404);
            return true;
        } catch (err) {
            log.error('Settings API error', { path, method, err });
            sendJson(res, { error: 'Internal server error' }, 500);
            return true;
        }
    };
}
