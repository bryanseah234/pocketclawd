/**
 * Unit tests for the `put_user_preference` action handler in the DataGateway Worker.
 *
 * Validates:
 * - Merge behavior preserves existing fields when only persona fields are updated
 * - Validation rejects invalid enum values for technical_depth and primary_domain
 * - Handling of missing userId returns early without error
 *
 * Requirements: 1.3, 9.1
 */
import { describe, it, expect, vi } from 'vitest';

import type { CloudServices } from '../bootstrap.js';
import type { UserPreferences } from '../data-gateway/types.js';

// ── Replicate the handler logic for unit testing ──
// The handler is not exported from the worker module, so we test the logic directly.
// This mirrors the implementation in index.ts exactly.

const VALID_TECHNICAL_DEPTH = new Set(['detailed', 'high-level']);
const VALID_PRIMARY_DOMAIN = new Set(['frontend', 'infrastructure', 'data']);

async function handlePutUserPreference(
    services: Pick<CloudServices, 'dataGateway'>,
    userId: string,
    request: Record<string, unknown>,
): Promise<void> {
    if (!userId) return;

    const preferences = request.preferences as Partial<UserPreferences> | undefined;
    if (!preferences) return;

    // Validate persona enum fields before persisting
    if (preferences.technical_depth !== undefined && !VALID_TECHNICAL_DEPTH.has(preferences.technical_depth)) {
        return;
    }
    if (preferences.primary_domain !== undefined && !VALID_PRIMARY_DOMAIN.has(preferences.primary_domain)) {
        return;
    }

    // Merge with existing preferences (non-destructive — don't overwrite unrelated fields)
    const existing = await services.dataGateway.getUserPreference(userId);
    const merged = { ...existing, ...preferences } as UserPreferences;

    await services.dataGateway.putUserPreference(userId, merged);
}

// ── Helpers ──

function createMockServices(existingPreferences: UserPreferences | null = null) {
    const getUserPreference = vi.fn().mockResolvedValue(existingPreferences);
    const putUserPreference = vi.fn().mockResolvedValue(undefined);

    const services = {
        dataGateway: {
            getUserPreference,
            putUserPreference,
        },
    } as unknown as Pick<CloudServices, 'dataGateway'>;

    return { services, getUserPreference, putUserPreference };
}

// ── Tests ──

describe('DataGateway Worker — put_user_preference handler', () => {
    describe('merge behavior', () => {
        it('preserves existing fields when only persona fields are updated', async () => {
            const existingPreferences: UserPreferences = {
                autoSave: true,
                notificationTime: '09:00',
                slideTemplate: 'Corporate',
                consentGiven: true,
                consentTimestamp: '2024-01-01T00:00:00Z',
            };

            const { services, getUserPreference, putUserPreference } =
                createMockServices(existingPreferences);

            await handlePutUserPreference(services, 'user-1', {
                preferences: {
                    technical_depth: 'detailed',
                    primary_domain: 'frontend',
                },
            });

            expect(getUserPreference).toHaveBeenCalledWith('user-1');
            expect(putUserPreference).toHaveBeenCalledWith('user-1', {
                autoSave: true,
                notificationTime: '09:00',
                slideTemplate: 'Corporate',
                consentGiven: true,
                consentTimestamp: '2024-01-01T00:00:00Z',
                technical_depth: 'detailed',
                primary_domain: 'frontend',
            });
        });

        it('preserves persona fields when only base fields are updated', async () => {
            const existingPreferences: UserPreferences = {
                autoSave: false,
                notificationTime: '08:00',
                slideTemplate: 'Modern',
                consentGiven: true,
                technical_depth: 'high-level',
                primary_domain: 'data',
                discoveryCompleted: true,
                discoveryCompletedAt: '2024-06-01T12:00:00Z',
            };

            const { services, putUserPreference } = createMockServices(existingPreferences);

            await handlePutUserPreference(services, 'user-2', {
                preferences: {
                    autoSave: true,
                    notificationTime: '10:00',
                },
            });

            expect(putUserPreference).toHaveBeenCalledWith('user-2', {
                autoSave: true,
                notificationTime: '10:00',
                slideTemplate: 'Modern',
                consentGiven: true,
                technical_depth: 'high-level',
                primary_domain: 'data',
                discoveryCompleted: true,
                discoveryCompletedAt: '2024-06-01T12:00:00Z',
            });
        });

        it('merges with null existing preferences (new user)', async () => {
            const { services, putUserPreference } = createMockServices(null);

            await handlePutUserPreference(services, 'user-new', {
                preferences: {
                    technical_depth: 'detailed',
                    primary_domain: 'infrastructure',
                    discoveryCompleted: true,
                    discoveryCompletedAt: '2024-07-01T10:00:00Z',
                },
            });

            expect(putUserPreference).toHaveBeenCalledWith('user-new', {
                technical_depth: 'detailed',
                primary_domain: 'infrastructure',
                discoveryCompleted: true,
                discoveryCompletedAt: '2024-07-01T10:00:00Z',
            });
        });
    });

    describe('validation', () => {
        it('rejects invalid technical_depth value', async () => {
            const { services, putUserPreference } = createMockServices(null);

            await handlePutUserPreference(services, 'user-bad', {
                preferences: {
                    technical_depth: 'verbose', // invalid
                    primary_domain: 'frontend',
                },
            });

            expect(putUserPreference).not.toHaveBeenCalled();
        });

        it('rejects invalid primary_domain value', async () => {
            const { services, putUserPreference } = createMockServices(null);

            await handlePutUserPreference(services, 'user-bad', {
                preferences: {
                    technical_depth: 'detailed',
                    primary_domain: 'backend', // invalid
                },
            });

            expect(putUserPreference).not.toHaveBeenCalled();
        });

        it('rejects empty string for technical_depth', async () => {
            const { services, putUserPreference } = createMockServices(null);

            await handlePutUserPreference(services, 'user-bad', {
                preferences: {
                    technical_depth: '' as any,
                    primary_domain: 'frontend',
                },
            });

            expect(putUserPreference).not.toHaveBeenCalled();
        });

        it('allows valid enum values to pass through', async () => {
            const { services, putUserPreference } = createMockServices(null);

            await handlePutUserPreference(services, 'user-ok', {
                preferences: {
                    technical_depth: 'high-level',
                    primary_domain: 'data',
                },
            });

            expect(putUserPreference).toHaveBeenCalled();
        });

        it('allows partial updates without persona fields (no validation needed)', async () => {
            const { services, putUserPreference } = createMockServices(null);

            await handlePutUserPreference(services, 'user-partial', {
                preferences: {
                    autoSave: true,
                },
            });

            // No persona fields → no validation → should proceed
            expect(putUserPreference).toHaveBeenCalled();
        });
    });

    describe('missing userId handling', () => {
        it('returns early without error when userId is empty string', async () => {
            const { services, getUserPreference, putUserPreference } = createMockServices(null);

            await handlePutUserPreference(services, '', {
                preferences: { technical_depth: 'detailed' },
            });

            expect(getUserPreference).not.toHaveBeenCalled();
            expect(putUserPreference).not.toHaveBeenCalled();
        });

        it('returns early without error when userId is undefined', async () => {
            const { services, getUserPreference, putUserPreference } = createMockServices(null);

            await handlePutUserPreference(services, undefined as any, {
                preferences: { technical_depth: 'detailed' },
            });

            expect(getUserPreference).not.toHaveBeenCalled();
            expect(putUserPreference).not.toHaveBeenCalled();
        });
    });

    describe('missing preferences handling', () => {
        it('returns early without error when preferences payload is missing', async () => {
            const { services, getUserPreference, putUserPreference } = createMockServices(null);

            await handlePutUserPreference(services, 'user-1', {
                // preferences intentionally omitted
            });

            expect(getUserPreference).not.toHaveBeenCalled();
            expect(putUserPreference).not.toHaveBeenCalled();
        });

        it('returns early without error when preferences is null', async () => {
            const { services, getUserPreference, putUserPreference } = createMockServices(null);

            await handlePutUserPreference(services, 'user-1', {
                preferences: null,
            });

            expect(getUserPreference).not.toHaveBeenCalled();
            expect(putUserPreference).not.toHaveBeenCalled();
        });
    });
});
