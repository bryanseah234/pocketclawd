/**
 * Scheduler Service — cron-based daily notification scheduler.
 *
 * Runs a cron job every minute that checks each active user's preferred
 * notification time (from DynamoDB user_preferences). When the current time
 * in Asia/Singapore timezone matches a user's notificationTime (HH:MM),
 * it enqueues a notification message to Redis for the sub-agent to process.
 *
 * The sub-agent generates the actual notification content (daily summary,
 * reminders, etc.) and delivers it via the standard message pipeline.
 *
 * Default notification time: 09:00 SGT (Asia/Singapore timezone).
 *
 * Requirements: REQ-4.3
 */

import { randomUUID } from 'node:crypto';

import type { QueueMessage } from '../redis-queue/types.js';
import type {
    ISchedulerService,
    NotificationPayload,
    NotificationResult,
    SchedulerConfig,
    SchedulerDependencies,
    UserNotificationState,
} from './types.js';

export type {
    ISchedulerService,
    NotificationPayload,
    NotificationResult,
    SchedulerConfig,
    SchedulerDependencies,
    UserNotificationState,
} from './types.js';

/** Default scheduler configuration. */
const DEFAULT_CONFIG: SchedulerConfig = {
    defaultNotificationTime: '09:00',
    defaultTimezone: 'Asia/Singapore',
    cronExpression: '* * * * *', // Every minute
    enabled: true,
};

/**
 * Interval in milliseconds for the scheduler tick (1 minute).
 * Uses setInterval internally; the cronExpression is retained for
 * future migration to node-cron when the package is installed.
 */
const TICK_INTERVAL_MS = 60_000;

export class SchedulerService implements ISchedulerService {
    private readonly config: SchedulerConfig;
    private readonly deps: SchedulerDependencies;
    private intervalHandle: ReturnType<typeof setInterval> | null = null;
    private running = false;

    /**
     * Tracks which users have already been notified today to prevent
     * duplicate notifications within the same day.
     */
    private notifiedToday: Map<string, UserNotificationState> = new Map();

    constructor(deps: SchedulerDependencies, config?: Partial<SchedulerConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.deps = deps;
    }

    // ── Public API ──

    start(): void {
        if (this.running) {
            return;
        }

        if (!this.config.enabled) {
            return;
        }

        this.intervalHandle = setInterval(() => {
            void this.checkAndNotify();
        }, TICK_INTERVAL_MS);

        this.running = true;
    }

    stop(): void {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
        this.running = false;
    }

    isRunning(): boolean {
        return this.running;
    }

    /**
     * Core scheduling logic: check all active users and enqueue notifications
     * for those whose preferred time matches the current time (HH:MM).
     *
     * This method is called every minute by the cron job.
     */
    async checkAndNotify(): Promise<NotificationResult> {
        const now = this.getCurrentTime();
        const currentHHMM = this.formatTimeHHMM(now);
        const currentDate = this.formatDateYYYYMMDD(now);

        // Clean up stale notification tracking from previous days
        this.cleanupStaleNotifications(currentDate);

        const result: NotificationResult = {
            usersChecked: 0,
            notificationsSent: 0,
            notifiedUsers: [],
            errors: [],
        };

        let activeUserIds: string[];
        try {
            activeUserIds = await this.deps.getActiveUserIds();
        } catch (err) {
            result.errors.push({
                userId: 'system',
                error: `Failed to get active user IDs: ${err instanceof Error ? err.message : String(err)}`,
            });
            return result;
        }

        result.usersChecked = activeUserIds.length;

        for (const userId of activeUserIds) {
            try {
                // Skip if already notified today
                if (this.wasNotifiedToday(userId, currentDate)) {
                    continue;
                }

                // Get user's preferred notification time
                const notificationTime = await this.getUserNotificationTime(userId);

                // Check if current time matches the user's preferred time
                if (currentHHMM === notificationTime) {
                    await this.sendNotification(userId);
                    this.markAsNotified(userId, currentDate);
                    result.notificationsSent++;
                    result.notifiedUsers.push(userId);
                }
            } catch (err) {
                result.errors.push({
                    userId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        return result;
    }

    // ── Private helpers ──

    /**
     * Get the user's preferred notification time from DynamoDB preferences.
     * Falls back to the default (09:00) if no preference is set.
     */
    private async getUserNotificationTime(userId: string): Promise<string> {
        const prefs = await this.deps.dataGateway.getUserPreference(userId);

        if (prefs?.notificationTime) {
            return prefs.notificationTime;
        }

        return this.config.defaultNotificationTime;
    }

    /**
     * Enqueue a notification message to Redis for the sub-agent to process.
     * The sub-agent will generate the notification content (daily summary, etc.).
     */
    private async sendNotification(userId: string): Promise<void> {
        const payload: NotificationPayload = {
            type: 'daily_summary',
            triggeredAt: new Date().toISOString(),
        };

        const message: QueueMessage = {
            id: randomUUID(),
            userId,
            type: 'notification',
            payload: payload as unknown as Record<string, unknown>,
            timestamp: new Date().toISOString(),
        };

        await this.deps.messageQueue.enqueueForAgent(userId, message);
    }

    /**
     * Check if a user was already notified today.
     */
    private wasNotifiedToday(userId: string, currentDate: string): boolean {
        const state = this.notifiedToday.get(userId);
        return state?.lastNotifiedDate === currentDate;
    }

    /**
     * Mark a user as notified for today.
     */
    private markAsNotified(userId: string, currentDate: string): void {
        this.notifiedToday.set(userId, {
            userId,
            lastNotifiedDate: currentDate,
        });
    }

    /**
     * Remove stale notification tracking entries from previous days.
     * This ensures users get notified again on a new day.
     */
    private cleanupStaleNotifications(currentDate: string): void {
        for (const [userId, state] of this.notifiedToday) {
            if (state.lastNotifiedDate !== currentDate) {
                this.notifiedToday.delete(userId);
            }
        }
    }

    /**
     * Get the current time. Uses the injected time function if available (for testing),
     * otherwise uses the real system time in the configured timezone.
     */
    private getCurrentTime(): Date {
        if (this.deps.getCurrentTime) {
            return this.deps.getCurrentTime();
        }
        return new Date();
    }

    /**
     * Format a Date to HH:MM string in the configured timezone.
     */
    private formatTimeHHMM(date: Date): string {
        const formatter = new Intl.DateTimeFormat('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: this.config.defaultTimezone,
        });

        return formatter.format(date);
    }

    /**
     * Format a Date to YYYY-MM-DD string in the configured timezone.
     */
    private formatDateYYYYMMDD(date: Date): string {
        const formatter = new Intl.DateTimeFormat('en-CA', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            timeZone: this.config.defaultTimezone,
        });

        return formatter.format(date);
    }
}
