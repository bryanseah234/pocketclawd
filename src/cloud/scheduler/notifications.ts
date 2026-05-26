/**
 * Daily Notification Job — generates and sends personalized briefings
 * to all active users at 9:00 AM SGT.
 *
 * Sends notifications with a 3-second gap between recipients to avoid
 * WhatsApp rate limiting.
 *
 * Requirements: REQ-9.3 (Scheduled Tasks)
 */

import { log } from '../../log.js';

import type { CloudServices } from '../bootstrap.js';

const NOTIFICATION_DELAY_MS = 3000; // 3s between recipients

/**
 * Generate and send daily notifications to all active users.
 * Called by the scheduler service at 9:00 AM SGT.
 */
export async function sendDailyNotifications(
    services: CloudServices,
    getActiveUserIds: () => Promise<string[]>,
): Promise<void> {
    log.info('Daily notification job starting');

    const userIds = await getActiveUserIds();
    if (userIds.length === 0) {
        log.info('Daily notification job: no active users');
        return;
    }

    let sent = 0;
    let failed = 0;

    for (const userId of userIds) {
        try {
            // Enqueue a notification generation task to the user's sub-agent
            await services.messageQueue.enqueueForAgent(userId, {
                id: `notification-${Date.now()}-${userId}`,
                userId,
                type: 'daily_notification',
                payload: {
                    notificationType: 'daily_briefing',
                    timezone: 'Asia/Singapore',
                    timestamp: new Date().toISOString(),
                },
                timestamp: new Date().toISOString(),
            });
            sent++;

            // Rate limit: 3s gap between recipients
            if (sent < userIds.length) {
                await new Promise((resolve) => setTimeout(resolve, NOTIFICATION_DELAY_MS));
            }
        } catch (err) {
            failed++;
            log.error('Failed to enqueue daily notification', { userId, err });
        }
    }

    log.info('Daily notification job complete', { sent, failed, total: userIds.length });
}
