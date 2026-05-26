/**
 * Unit tests for PDPA compliance commands module (task 11.2).
 * Tests /export, /deleteaccount commands and consent collection flow.
 * Requirements: REQ-7.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    handlePdpaCommand,
    checkConsent,
    clearPendingState,
    hasPendingDeletion,
    hasPendingConsent,
    PDPA_MESSAGES,
} from './index.js';
import type { PdpaDependencies } from './types.js';
import type { IDataGateway, UserPreferences, UserDataExport, DeletionReceipt } from '../data-gateway/types.js';

function createMockDeps(overrides?: Partial<PdpaDependencies>): PdpaDependencies {
    const mockGateway: Partial<IDataGateway> = {
        getUserPreference: vi.fn().mockResolvedValue(null),
        putUserPreference: vi.fn().mockResolvedValue(undefined),
        exportUserData: vi.fn().mockResolvedValue({
            userId: 'user-1',
            exportedAt: '2024-06-15T10:00:00Z',
            chatMessages: [],
            preferences: null,
            documents: [],
            files: [],
        } satisfies UserDataExport),
        deleteAllUserData: vi.fn().mockResolvedValue({
            userId: 'user-1',
            deletedAt: '2024-06-15T10:00:00Z',
            dynamoDbRecordsDeleted: 5,
            openSearchDocumentsDeleted: 3,
            s3ObjectsDeleted: 2,
        } satisfies DeletionReceipt),
    };

    return {
        dataGateway: mockGateway as IDataGateway,
        config: {
            s3Bucket: 'test-bucket',
            exportUrlPrefix: 'https://s3.example.com/exports',
            exportLinkTtlSeconds: 86400,
        },
        sendMessage: vi.fn().mockResolvedValue(undefined),
        uploadExport: vi.fn().mockResolvedValue('https://s3.example.com/exports/user-1/export.json'),
        ...overrides,
    };
}

describe('PDPA Compliance Commands', () => {
    beforeEach(() => {
        clearPendingState();
    });

    describe('handlePdpaCommand — /export', () => {
        it('handles /export command and sends download link', async () => {
            const deps = createMockDeps();

            const result = await handlePdpaCommand('user-1', '/export', deps);

            expect(result.handled).toBe(true);
            expect(deps.dataGateway.exportUserData).toHaveBeenCalledWith('user-1');
            expect(deps.uploadExport).toHaveBeenCalledWith('user-1', expect.any(Buffer));
            expect(deps.sendMessage).toHaveBeenCalledWith('user-1', PDPA_MESSAGES.EXPORT_STARTED);
            expect(deps.sendMessage).toHaveBeenCalledWith(
                'user-1',
                expect.stringContaining('https://s3.example.com/exports/user-1/export.json'),
            );
        });

        it('handles /export with leading/trailing whitespace', async () => {
            const deps = createMockDeps();

            const result = await handlePdpaCommand('user-1', '  /export  ', deps);

            expect(result.handled).toBe(true);
            expect(deps.dataGateway.exportUserData).toHaveBeenCalledWith('user-1');
        });

        it('handles /export case-insensitively', async () => {
            const deps = createMockDeps();

            const result = await handlePdpaCommand('user-1', '/EXPORT', deps);

            expect(result.handled).toBe(true);
            expect(deps.dataGateway.exportUserData).toHaveBeenCalledWith('user-1');
        });

        it('sends error message when export fails', async () => {
            const deps = createMockDeps({
                dataGateway: {
                    exportUserData: vi.fn().mockRejectedValue(new Error('S3 error')),
                    getUserPreference: vi.fn(),
                    putUserPreference: vi.fn(),
                } as unknown as IDataGateway,
            });

            const result = await handlePdpaCommand('user-1', '/export', deps);

            expect(result.handled).toBe(true);
            if (result.handled) {
                expect(result.response).toBe(PDPA_MESSAGES.EXPORT_FAILED);
            }
            expect(deps.sendMessage).toHaveBeenCalledWith('user-1', PDPA_MESSAGES.EXPORT_FAILED);
        });

        it('serializes export data as formatted JSON', async () => {
            const exportData: UserDataExport = {
                userId: 'user-1',
                exportedAt: '2024-06-15T10:00:00Z',
                chatMessages: [{ messageId: 'msg-1', role: 'user', content: 'Hello', timestamp: '2024-06-15T10:00:00Z' }],
                preferences: { autoSave: true, notificationTime: '09:00', slideTemplate: 'Corporate', consentGiven: true, consentTimestamp: '2024-01-01T00:00:00Z' },
                documents: [],
                files: [],
            };

            const deps = createMockDeps({
                dataGateway: {
                    exportUserData: vi.fn().mockResolvedValue(exportData),
                    getUserPreference: vi.fn(),
                    putUserPreference: vi.fn(),
                } as unknown as IDataGateway,
            });

            await handlePdpaCommand('user-1', '/export', deps);

            const uploadCall = (deps.uploadExport as ReturnType<typeof vi.fn>).mock.calls[0];
            const buffer = uploadCall[1] as Buffer;
            const parsed = JSON.parse(buffer.toString('utf-8'));
            expect(parsed.userId).toBe('user-1');
            expect(parsed.chatMessages).toHaveLength(1);
        });
    });

    describe('handlePdpaCommand — /deleteaccount', () => {
        it('asks for confirmation before deleting', async () => {
            const deps = createMockDeps();

            const result = await handlePdpaCommand('user-1', '/deleteaccount', deps);

            expect(result.handled).toBe(true);
            if (result.handled) {
                expect(result.response).toBe(PDPA_MESSAGES.DELETE_CONFIRM);
            }
            expect(deps.sendMessage).toHaveBeenCalledWith('user-1', PDPA_MESSAGES.DELETE_CONFIRM);
            expect(hasPendingDeletion('user-1')).toBe(true);
            // Should NOT have called deleteAllUserData yet
            expect(deps.dataGateway.deleteAllUserData).not.toHaveBeenCalled();
        });

        it('deletes all data when user confirms', async () => {
            const deps = createMockDeps();

            // First: trigger the delete command
            await handlePdpaCommand('user-1', '/deleteaccount', deps);

            // Second: confirm deletion
            const result = await handlePdpaCommand('user-1', 'confirm', deps);

            expect(result.handled).toBe(true);
            if (result.handled) {
                expect(result.response).toBe(PDPA_MESSAGES.DELETE_SUCCESS);
            }
            expect(deps.dataGateway.deleteAllUserData).toHaveBeenCalledWith('user-1');
            expect(hasPendingDeletion('user-1')).toBe(false);
        });

        it('cancels deletion when user replies cancel', async () => {
            const deps = createMockDeps();

            await handlePdpaCommand('user-1', '/deleteaccount', deps);
            const result = await handlePdpaCommand('user-1', 'cancel', deps);

            expect(result.handled).toBe(true);
            if (result.handled) {
                expect(result.response).toBe(PDPA_MESSAGES.DELETE_CANCELLED);
            }
            expect(deps.dataGateway.deleteAllUserData).not.toHaveBeenCalled();
            expect(hasPendingDeletion('user-1')).toBe(false);
        });

        it('cancels deletion on any non-confirm response', async () => {
            const deps = createMockDeps();

            await handlePdpaCommand('user-1', '/deleteaccount', deps);
            const result = await handlePdpaCommand('user-1', 'something else', deps);

            expect(result.handled).toBe(true);
            if (result.handled) {
                expect(result.response).toBe(PDPA_MESSAGES.DELETE_CANCELLED);
            }
            expect(deps.dataGateway.deleteAllUserData).not.toHaveBeenCalled();
        });

        it('sends error message when deletion fails', async () => {
            const deps = createMockDeps({
                dataGateway: {
                    deleteAllUserData: vi.fn().mockRejectedValue(new Error('DynamoDB error')),
                    getUserPreference: vi.fn(),
                    putUserPreference: vi.fn(),
                } as unknown as IDataGateway,
            });

            await handlePdpaCommand('user-1', '/deleteaccount', deps);
            const result = await handlePdpaCommand('user-1', 'confirm', deps);

            expect(result.handled).toBe(true);
            if (result.handled) {
                expect(result.response).toBe(PDPA_MESSAGES.DELETE_FAILED);
            }
            expect(deps.sendMessage).toHaveBeenCalledWith('user-1', PDPA_MESSAGES.DELETE_FAILED);
        });

        it('handles /deleteaccount case-insensitively', async () => {
            const deps = createMockDeps();

            const result = await handlePdpaCommand('user-1', '/DELETEACCOUNT', deps);

            expect(result.handled).toBe(true);
            expect(hasPendingDeletion('user-1')).toBe(true);
        });
    });

    describe('handlePdpaCommand — non-PDPA messages', () => {
        it('returns handled: false for regular messages', async () => {
            const deps = createMockDeps();

            const result = await handlePdpaCommand('user-1', 'Hello, how are you?', deps);

            expect(result.handled).toBe(false);
        });

        it('returns handled: false for other slash commands', async () => {
            const deps = createMockDeps();

            const result = await handlePdpaCommand('user-1', '/help', deps);

            expect(result.handled).toBe(false);
        });

        it('returns handled: false for empty messages', async () => {
            const deps = createMockDeps();

            const result = await handlePdpaCommand('user-1', '', deps);

            expect(result.handled).toBe(false);
        });
    });

    describe('checkConsent — new user flow', () => {
        it('returns needsConsent: true for new users (no preferences)', async () => {
            const deps = createMockDeps();

            const result = await checkConsent('new-user', deps);

            expect(result.needsConsent).toBe(true);
            if (result.needsConsent) {
                expect(result.response).toBe(PDPA_MESSAGES.CONSENT_REQUEST);
            }
            expect(hasPendingConsent('new-user')).toBe(true);
        });

        it('returns needsConsent: true when consentGiven is false', async () => {
            const deps = createMockDeps({
                dataGateway: {
                    getUserPreference: vi.fn().mockResolvedValue({
                        autoSave: false,
                        notificationTime: '09:00',
                        slideTemplate: 'Corporate',
                        consentGiven: false,
                    } satisfies UserPreferences),
                    putUserPreference: vi.fn(),
                } as unknown as IDataGateway,
            });

            const result = await checkConsent('user-no-consent', deps);

            expect(result.needsConsent).toBe(true);
        });

        it('returns needsConsent: false when consent already given', async () => {
            const deps = createMockDeps({
                dataGateway: {
                    getUserPreference: vi.fn().mockResolvedValue({
                        autoSave: true,
                        notificationTime: '09:00',
                        slideTemplate: 'Corporate',
                        consentGiven: true,
                        consentTimestamp: '2024-01-01T00:00:00Z',
                    } satisfies UserPreferences),
                    putUserPreference: vi.fn(),
                } as unknown as IDataGateway,
            });

            const result = await checkConsent('existing-user', deps);

            expect(result.needsConsent).toBe(false);
            expect(hasPendingConsent('existing-user')).toBe(false);
        });

        it('does not re-trigger consent if already in consent flow', async () => {
            const deps = createMockDeps();

            // First call enters consent flow
            await checkConsent('new-user', deps);
            expect(hasPendingConsent('new-user')).toBe(true);

            // Second call should not re-trigger
            const result = await checkConsent('new-user', deps);
            expect(result.needsConsent).toBe(false);
        });

        it('stores consent when user replies yes', async () => {
            const deps = createMockDeps();

            // Enter consent flow
            await checkConsent('new-user', deps);

            // User replies yes
            const result = await handlePdpaCommand('new-user', 'yes', deps);

            expect(result.handled).toBe(true);
            if (result.handled) {
                expect(result.response).toBe(PDPA_MESSAGES.CONSENT_ACCEPTED);
            }
            expect(deps.dataGateway.putUserPreference).toHaveBeenCalledWith(
                'new-user',
                expect.objectContaining({
                    consentGiven: true,
                    consentTimestamp: expect.any(String),
                }),
            );
            expect(hasPendingConsent('new-user')).toBe(false);
        });

        it('handles consent decline', async () => {
            const deps = createMockDeps();

            await checkConsent('new-user', deps);
            const result = await handlePdpaCommand('new-user', 'no', deps);

            expect(result.handled).toBe(true);
            if (result.handled) {
                expect(result.response).toBe(PDPA_MESSAGES.CONSENT_DECLINED);
            }
            expect(deps.dataGateway.putUserPreference).not.toHaveBeenCalled();
            expect(hasPendingConsent('new-user')).toBe(false);
        });

        it('treats any non-yes response as decline', async () => {
            const deps = createMockDeps();

            await checkConsent('new-user', deps);
            const result = await handlePdpaCommand('new-user', 'maybe', deps);

            expect(result.handled).toBe(true);
            if (result.handled) {
                expect(result.response).toBe(PDPA_MESSAGES.CONSENT_DECLINED);
            }
        });

        it('handles yes case-insensitively', async () => {
            const deps = createMockDeps();

            await checkConsent('new-user', deps);
            const result = await handlePdpaCommand('new-user', 'YES', deps);

            expect(result.handled).toBe(true);
            if (result.handled) {
                expect(result.response).toBe(PDPA_MESSAGES.CONSENT_ACCEPTED);
            }
            expect(deps.dataGateway.putUserPreference).toHaveBeenCalled();
        });

        it('preserves existing preferences when storing consent', async () => {
            const existingPrefs: UserPreferences = {
                autoSave: true,
                notificationTime: '10:30',
                slideTemplate: 'Modern',
                consentGiven: false,
            };

            const deps = createMockDeps({
                dataGateway: {
                    getUserPreference: vi.fn().mockResolvedValue(existingPrefs),
                    putUserPreference: vi.fn().mockResolvedValue(undefined),
                    exportUserData: vi.fn(),
                    deleteAllUserData: vi.fn(),
                } as unknown as IDataGateway,
            });

            await checkConsent('user-1', deps);
            await handlePdpaCommand('user-1', 'yes', deps);

            expect(deps.dataGateway.putUserPreference).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({
                    autoSave: true,
                    notificationTime: '10:30',
                    slideTemplate: 'Modern',
                    consentGiven: true,
                    consentTimestamp: expect.any(String),
                }),
            );
        });
    });

    describe('isolation between users', () => {
        it('pending deletion for one user does not affect another', async () => {
            const deps = createMockDeps();

            await handlePdpaCommand('user-1', '/deleteaccount', deps);

            // user-2 sends a normal message — should not be intercepted
            const result = await handlePdpaCommand('user-2', 'hello', deps);
            expect(result.handled).toBe(false);

            expect(hasPendingDeletion('user-1')).toBe(true);
            expect(hasPendingDeletion('user-2')).toBe(false);
        });

        it('pending consent for one user does not affect another', async () => {
            const deps = createMockDeps();

            await checkConsent('new-user-1', deps);

            // new-user-2 should get their own consent flow
            const result = await checkConsent('new-user-2', deps);
            expect(result.needsConsent).toBe(true);

            expect(hasPendingConsent('new-user-1')).toBe(true);
            expect(hasPendingConsent('new-user-2')).toBe(true);
        });
    });
});
