/**
 * Unit tests for the Scheduler Service.
 *
 * Tests the daily notification scheduling logic including:
 * - Time matching against user preferences
 * - Default notification time fallback
 * - Duplicate prevention (once per day per user)
 * - Error handling for individual users
 * - Redis message enqueuing
 *
 * Requirements: REQ-4.3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SchedulerService } from './index.js';
import type { SchedulerDependencies } from './types.js';
import type { IDataGateway, UserPreferences } from '../data-gateway/types.js';
import type { IMessageQueue, QueueMessage } from '../redis-queue/types.js';

// ── Mock factories ──

function createMockDataGateway(prefsMap: Map<string, UserPreferences | null> = new Map()): IDataGateway {
    return {
        getUserPreference: vi.fn(async (userId: string) => prefsMap.get(userId) ?? null),
        // Stub remaining methods (not used by scheduler)
        ensureIndex: vi.fn(),
        putChatMessage: vi.fn(),
        getChatHistory: vi.fn(),
        getChatHistoryPaginated: vi.fn(),
        putUserPreference: vi.fn(),
        createWebhookToken: vi.fn(),
        validateWebhookToken: vi.fn(),
        logSystemError: vi.fn(),
        indexDocument: vi.fn(),
        hybridSearch: vi.fn(),
        deleteUserDocuments: vi.fn(),
        uploadFile: vi.fn(),
        getFile: vi.fn(),
        listFiles: vi.fn(),
        deleteFile: vi.fn(),
        logAccess: vi.fn(),
        exportUserData: vi.fn(),
        deleteAllUserData: vi.fn(),
    } as unknown as IDataGateway;
}

function createMockMessageQueue(): IMessageQueue & { enqueueForAgent: ReturnType<typeof vi.fn> } {
    return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        enqueueForAgent: vi.fn(async () => { }),
        dequeueForAgent: vi.fn(),
        enqueueResponse: vi.fn(),
        dequeueResponse: vi.fn(),
        moveToDLQ: vi.fn(),
        retryFromDLQ: vi.fn(),
        getQueueDepth: vi.fn(),
        isBackpressured: vi.fn(),
    };
}

function createDeps(overrides?: Partial<SchedulerDependencies>): SchedulerDependencies {
    return {
        dataGateway: createMockDataGateway(),
        messageQueue: createMockMessageQueue(),
        getActiveUserIds: vi.fn(async () => []),
        getCurrentTime: () => new Date('2025-01-15T01:00:00Z'), // 09:00 SGT
        ...overrides,
    };
}

// ── Tests ──

describe('SchedulerService', () => {
    let scheduler: SchedulerService;

    afterEach(() => {
        scheduler?.stop();
    });

    describe('start/stop lifecycle', () => {
        it('should start and report running', () => {
            const deps = createDeps();
            scheduler = new SchedulerService(deps);

            expect(scheduler.isRunning()).toBe(false);
            scheduler.start();
            expect(scheduler.isRunning()).toBe(true);
        });

        it('should stop and report not running', () => {
            const deps = createDeps();
            scheduler = new SchedulerService(deps);

            scheduler.start();
            scheduler.stop();
            expect(scheduler.isRunning()).toBe(false);
        });

        it('should not start if disabled', () => {
            const deps = createDeps();
            scheduler = new SchedulerService(deps, { enabled: false });

            scheduler.start();
            expect(scheduler.isRunning()).toBe(false);
        });

        it('should be idempotent on multiple start calls', () => {
            const deps = createDeps();
            scheduler = new SchedulerService(deps);

            scheduler.start();
            scheduler.start(); // Should not throw or create duplicate cron jobs
            expect(scheduler.isRunning()).toBe(true);
        });
    });

    describe('checkAndNotify', () => {
        it('should send notification when user time matches current time', async () => {
            const prefsMap = new Map<string, UserPreferences | null>([
                ['user-1', { autoSave: false, notificationTime: '09:00', slideTemplate: 'Corporate', consentGiven: true }],
            ]);

            const mockQueue = createMockMessageQueue();
            const deps = createDeps({
                dataGateway: createMockDataGateway(prefsMap),
                messageQueue: mockQueue,
                getActiveUserIds: vi.fn(async () => ['user-1']),
                // 09:00 SGT = 01:00 UTC
                getCurrentTime: () => new Date('2025-01-15T01:00:00Z'),
            });

            scheduler = new SchedulerService(deps);
            const result = await scheduler.checkAndNotify();

            expect(result.usersChecked).toBe(1);
            expect(result.notificationsSent).toBe(1);
            expect(result.notifiedUsers).toContain('user-1');
            expect(mockQueue.enqueueForAgent).toHaveBeenCalledOnce();

            // Verify the enqueued message structure
            const call = mockQueue.enqueueForAgent.mock.calls[0];
            expect(call[0]).toBe('user-1');
            const message = call[1] as QueueMessage;
            expect(message.userId).toBe('user-1');
            expect(message.type).toBe('notification');
            expect(message.payload).toHaveProperty('type', 'daily_summary');
            expect(message.payload).toHaveProperty('triggeredAt');
        });

        it('should not send notification when time does not match', async () => {
            const prefsMap = new Map<string, UserPreferences | null>([
                ['user-1', { autoSave: false, notificationTime: '10:00', slideTemplate: 'Corporate', consentGiven: true }],
            ]);

            const mockQueue = createMockMessageQueue();
            const deps = createDeps({
                dataGateway: createMockDataGateway(prefsMap),
                messageQueue: mockQueue,
                getActiveUserIds: vi.fn(async () => ['user-1']),
                // 09:00 SGT = 01:00 UTC, user wants 10:00
                getCurrentTime: () => new Date('2025-01-15T01:00:00Z'),
            });

            scheduler = new SchedulerService(deps);
            const result = await scheduler.checkAndNotify();

            expect(result.usersChecked).toBe(1);
            expect(result.notificationsSent).toBe(0);
            expect(mockQueue.enqueueForAgent).not.toHaveBeenCalled();
        });

        it('should use default time (09:00) when user has no preference', async () => {
            // User has no preferences stored
            const mockQueue = createMockMessageQueue();
            const deps = createDeps({
                dataGateway: createMockDataGateway(new Map()),
                messageQueue: mockQueue,
                getActiveUserIds: vi.fn(async () => ['user-no-prefs']),
                // 09:00 SGT = 01:00 UTC
                getCurrentTime: () => new Date('2025-01-15T01:00:00Z'),
            });

            scheduler = new SchedulerService(deps);
            const result = await scheduler.checkAndNotify();

            expect(result.notificationsSent).toBe(1);
            expect(result.notifiedUsers).toContain('user-no-prefs');
        });

        it('should not send duplicate notifications on the same day', async () => {
            const prefsMap = new Map<string, UserPreferences | null>([
                ['user-1', { autoSave: false, notificationTime: '09:00', slideTemplate: 'Corporate', consentGiven: true }],
            ]);

            const mockQueue = createMockMessageQueue();
            const deps = createDeps({
                dataGateway: createMockDataGateway(prefsMap),
                messageQueue: mockQueue,
                getActiveUserIds: vi.fn(async () => ['user-1']),
                getCurrentTime: () => new Date('2025-01-15T01:00:00Z'),
            });

            scheduler = new SchedulerService(deps);

            // First check — should notify
            const result1 = await scheduler.checkAndNotify();
            expect(result1.notificationsSent).toBe(1);

            // Second check same day — should NOT notify again
            const result2 = await scheduler.checkAndNotify();
            expect(result2.notificationsSent).toBe(0);

            expect(mockQueue.enqueueForAgent).toHaveBeenCalledTimes(1);
        });

        it('should send notification again on a new day', async () => {
            const prefsMap = new Map<string, UserPreferences | null>([
                ['user-1', { autoSave: false, notificationTime: '09:00', slideTemplate: 'Corporate', consentGiven: true }],
            ]);

            const mockQueue = createMockMessageQueue();
            let currentTime = new Date('2025-01-15T01:00:00Z'); // Jan 15, 09:00 SGT

            const deps = createDeps({
                dataGateway: createMockDataGateway(prefsMap),
                messageQueue: mockQueue,
                getActiveUserIds: vi.fn(async () => ['user-1']),
                getCurrentTime: () => currentTime,
            });

            scheduler = new SchedulerService(deps);

            // Day 1 — should notify
            const result1 = await scheduler.checkAndNotify();
            expect(result1.notificationsSent).toBe(1);

            // Day 2 — advance to next day, should notify again
            currentTime = new Date('2025-01-16T01:00:00Z'); // Jan 16, 09:00 SGT
            const result2 = await scheduler.checkAndNotify();
            expect(result2.notificationsSent).toBe(1);

            expect(mockQueue.enqueueForAgent).toHaveBeenCalledTimes(2);
        });

        it('should handle multiple users with different notification times', async () => {
            const prefsMap = new Map<string, UserPreferences | null>([
                ['user-morning', { autoSave: false, notificationTime: '09:00', slideTemplate: 'Corporate', consentGiven: true }],
                ['user-afternoon', { autoSave: false, notificationTime: '14:00', slideTemplate: 'Modern', consentGiven: true }],
                ['user-evening', { autoSave: false, notificationTime: '18:00', slideTemplate: 'Elegant', consentGiven: true }],
            ]);

            const mockQueue = createMockMessageQueue();
            const deps = createDeps({
                dataGateway: createMockDataGateway(prefsMap),
                messageQueue: mockQueue,
                getActiveUserIds: vi.fn(async () => ['user-morning', 'user-afternoon', 'user-evening']),
                // 09:00 SGT
                getCurrentTime: () => new Date('2025-01-15T01:00:00Z'),
            });

            scheduler = new SchedulerService(deps);
            const result = await scheduler.checkAndNotify();

            expect(result.usersChecked).toBe(3);
            expect(result.notificationsSent).toBe(1);
            expect(result.notifiedUsers).toEqual(['user-morning']);
        });

        it('should handle errors for individual users without stopping others', async () => {
            const mockDataGateway = createMockDataGateway();
            (mockDataGateway.getUserPreference as ReturnType<typeof vi.fn>)
                .mockImplementation(async (userId: string) => {
                    if (userId === 'user-error') {
                        throw new Error('DynamoDB timeout');
                    }
                    return { autoSave: false, notificationTime: '09:00', slideTemplate: 'Corporate', consentGiven: true };
                });

            const mockQueue = createMockMessageQueue();
            const deps = createDeps({
                dataGateway: mockDataGateway,
                messageQueue: mockQueue,
                getActiveUserIds: vi.fn(async () => ['user-error', 'user-ok']),
                getCurrentTime: () => new Date('2025-01-15T01:00:00Z'),
            });

            scheduler = new SchedulerService(deps);
            const result = await scheduler.checkAndNotify();

            expect(result.usersChecked).toBe(2);
            expect(result.notificationsSent).toBe(1);
            expect(result.notifiedUsers).toContain('user-ok');
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].userId).toBe('user-error');
            expect(result.errors[0].error).toContain('DynamoDB timeout');
        });

        it('should handle failure to get active user IDs', async () => {
            const deps = createDeps({
                getActiveUserIds: vi.fn(async () => { throw new Error('Redis connection failed'); }),
                getCurrentTime: () => new Date('2025-01-15T01:00:00Z'),
            });

            scheduler = new SchedulerService(deps);
            const result = await scheduler.checkAndNotify();

            expect(result.usersChecked).toBe(0);
            expect(result.notificationsSent).toBe(0);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].userId).toBe('system');
            expect(result.errors[0].error).toContain('Redis connection failed');
        });

        it('should handle empty active users list', async () => {
            const mockQueue = createMockMessageQueue();
            const deps = createDeps({
                messageQueue: mockQueue,
                getActiveUserIds: vi.fn(async () => []),
                getCurrentTime: () => new Date('2025-01-15T01:00:00Z'),
            });

            scheduler = new SchedulerService(deps);
            const result = await scheduler.checkAndNotify();

            expect(result.usersChecked).toBe(0);
            expect(result.notificationsSent).toBe(0);
            expect(mockQueue.enqueueForAgent).not.toHaveBeenCalled();
        });

        it('should enqueue message with correct structure', async () => {
            const prefsMap = new Map<string, UserPreferences | null>([
                ['user-1', { autoSave: false, notificationTime: '09:00', slideTemplate: 'Corporate', consentGiven: true }],
            ]);

            const mockQueue = createMockMessageQueue();
            const deps = createDeps({
                dataGateway: createMockDataGateway(prefsMap),
                messageQueue: mockQueue,
                getActiveUserIds: vi.fn(async () => ['user-1']),
                getCurrentTime: () => new Date('2025-01-15T01:00:00Z'),
            });

            scheduler = new SchedulerService(deps);
            await scheduler.checkAndNotify();

            const [userId, message] = mockQueue.enqueueForAgent.mock.calls[0];
            expect(userId).toBe('user-1');
            expect(message).toMatchObject({
                userId: 'user-1',
                type: 'notification',
                payload: {
                    type: 'daily_summary',
                },
            });
            expect(message.id).toBeDefined();
            expect(message.timestamp).toBeDefined();
            expect(message.payload.triggeredAt).toBeDefined();
        });
    });

    describe('configurable defaults', () => {
        it('should use custom default notification time', async () => {
            // No user prefs, custom default of 08:00
            const mockQueue = createMockMessageQueue();
            const deps = createDeps({
                dataGateway: createMockDataGateway(new Map()),
                messageQueue: mockQueue,
                getActiveUserIds: vi.fn(async () => ['user-1']),
                // 08:00 SGT = 00:00 UTC
                getCurrentTime: () => new Date('2025-01-15T00:00:00Z'),
            });

            scheduler = new SchedulerService(deps, { defaultNotificationTime: '08:00' });
            const result = await scheduler.checkAndNotify();

            expect(result.notificationsSent).toBe(1);
        });

        it('should use custom timezone', async () => {
            const prefsMap = new Map<string, UserPreferences | null>([
                ['user-1', { autoSave: false, notificationTime: '09:00', slideTemplate: 'Corporate', consentGiven: true }],
            ]);

            const mockQueue = createMockMessageQueue();
            const deps = createDeps({
                dataGateway: createMockDataGateway(prefsMap),
                messageQueue: mockQueue,
                getActiveUserIds: vi.fn(async () => ['user-1']),
                // 09:00 UTC (for UTC timezone test)
                getCurrentTime: () => new Date('2025-01-15T09:00:00Z'),
            });

            scheduler = new SchedulerService(deps, { defaultTimezone: 'UTC' });
            const result = await scheduler.checkAndNotify();

            expect(result.notificationsSent).toBe(1);
        });
    });
});
