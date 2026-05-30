/* eslint-disable */

/**

 * Scheduler Service types — interfaces for the daily notification scheduler.

 *

 * The scheduler checks every minute whether any active user's preferred

 * notification time matches the current time, and if so, enqueues a

 * notification message to Redis for the sub-agent to process.

 *

 * Requirements: REQ-4.3

 */



import type { IDataGateway, UserPreferences } from '../data-gateway/types.js';

import type { IMessageQueue, QueueMessage } from '../redis-queue/types.js';

import type { DistributedLock } from '../redis-lock.js';



// ── Configuration ──



export interface SchedulerConfig {

    /** Default notification time in HH:MM format (24h). Defaults to "09:00". */

    defaultNotificationTime: string;



    /** Default timezone for notification scheduling. Defaults to "Asia/Singapore". */

    defaultTimezone: string;



    /** Cron expression for how often the scheduler checks. Defaults to every minute: "* * * * *". */

    cronExpression: string;



    /** Whether the scheduler is enabled. Defaults to true. */

    enabled: boolean;

}



// ── Notification payload ──



export interface NotificationPayload {

    /** Type of notification to generate. */

    type: 'daily_summary' | 'reminder' | 'custom';



    /** Optional custom prompt for the sub-agent to use when generating the notification. */

    prompt?: string;



    /** Timestamp when the notification was triggered. */

    triggeredAt: string; // ISO 8601

}



// ── User notification state (internal tracking) ──



export interface UserNotificationState {

    userId: string;

    lastNotifiedDate: string; // YYYY-MM-DD — prevents duplicate notifications on the same day

}



// ── Scheduler interface ──



export interface ISchedulerService {

    /** Start the cron-based scheduler. */

    start(): void;



    /** Stop the scheduler and clean up resources. */

    stop(): void;



    /** Whether the scheduler is currently running. */

    isRunning(): boolean;



    /**

     * Check all active users and send notifications for those whose

     * preferred time matches the current time. Called by the cron job.

     */

    checkAndNotify(): Promise<NotificationResult>;

}



// ── Result of a notification check cycle ──



export interface NotificationResult {

    /** Number of users checked. */

    usersChecked: number;



    /** Number of notifications enqueued. */

    notificationsSent: number;



    /** User IDs that were notified. */

    notifiedUsers: string[];



    /** Any errors encountered during the check. */

    errors: Array<{ userId: string; error: string }>;

}



// ── Dependencies interface (for dependency injection / testing) ──



export interface SchedulerDependencies {

    /** Data Gateway for reading user preferences. */

    dataGateway: IDataGateway;



    /** Message queue for enqueuing notification messages. */

    messageQueue: IMessageQueue;



    /** Function to get all active user IDs. */

    getActiveUserIds: () => Promise<string[]>;



    /** Optional: override current time for testing. */

    getCurrentTime?: () => Date;


    /**
     * Optional Redis-backed distributed lock for restart-safe, multi-replica
     * notification dedup (t2-11). When provided, the scheduler uses markOnce
     * instead of the in-process notifiedToday Map.
     */
    lock?: DistributedLock;
}


