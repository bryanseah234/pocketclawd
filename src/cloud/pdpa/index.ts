/* eslint-disable */
/**
 * PDPA Compliance Commands Module.
 *
 * Handles /export and /deleteaccount commands at the orchestrator level
 * (before routing to sub-agent). Also implements consent collection flow
 * for new users on first message.
 *
 * Requirements: REQ-7.3
 * - User consent collection before storing personal data
 * - Data export (/export command) within 24 hours
 * - Complete data deletion (/deleteaccount) within 30 days
 */

import type { IDataGateway } from '../data-gateway/types.js';
import type {
    PdpaCommandResult,
    ConsentCheckResult,
    PdpaConfig,
    PdpaDependencies,
} from './types.js';
import { PDPA_MESSAGES } from './types.js';

export { PDPA_MESSAGES } from './types.js';
export type { PdpaCommandResult, ConsentCheckResult, PdpaConfig, PdpaDependencies } from './types.js';

/**
 * Set of userIds currently awaiting deletion confirmation.
 * Keyed by userId, value is the ISO timestamp of the request.
 */
const pendingDeletions = new Map<string, string>();

/**
 * Set of userIds currently in the consent flow (awaiting yes/no response).
 */
const pendingConsent = new Set<string>();

/**
 * Check if an inbound message is a PDPA command and handle it.
 *
 * Call this at the orchestrator level BEFORE routing to sub-agent.
 * Returns { handled: true, response } if the message was consumed,
 * or { handled: false } if it should continue through normal routing.
 */
export async function handlePdpaCommand(
    userId: string,
    messageText: string,
    deps: PdpaDependencies,
): Promise<PdpaCommandResult> {
    const text = messageText.trim().toLowerCase();

    // Check if user is in pending deletion confirmation flow
    if (pendingDeletions.has(userId)) {
        return handleDeletionConfirmation(userId, text, deps);
    }

    // Check if user is in pending consent flow
    if (pendingConsent.has(userId)) {
        return handleConsentResponse(userId, text, deps);
    }

    // Check for PDPA commands
    if (text === '/export') {
        return handleExportCommand(userId, deps);
    }

    if (text === '/deleteaccount') {
        return handleDeleteAccountCommand(userId, deps);
    }

    return { handled: false };
}

/**
 * Check if a new user needs consent before their data can be stored.
 *
 * Call this for every inbound message. If the user has not given consent,
 * returns a consent request message and enters the consent flow.
 * If consent is already given, returns { needsConsent: false }.
 */
export async function checkConsent(
    userId: string,
    deps: PdpaDependencies,
): Promise<ConsentCheckResult> {
    // If already in consent flow, don't re-trigger
    if (pendingConsent.has(userId)) {
        return { needsConsent: false };
    }

    const prefs = await deps.dataGateway.getUserPreference(userId);

    // User has preferences and has given consent — proceed normally
    if (prefs?.consentGiven) {
        return { needsConsent: false };
    }

    // New user or consent not given — enter consent flow
    pendingConsent.add(userId);
    return {
        needsConsent: true,
        response: PDPA_MESSAGES.CONSENT_REQUEST,
    };
}

/**
 * Handle the /export command.
 * Triggers DataGateway.exportUserData(), uploads result to S3,
 * sends download link via WhatsApp.
 */
async function handleExportCommand(
    userId: string,
    deps: PdpaDependencies,
): Promise<PdpaCommandResult> {
    try {
        // Notify user that export is being prepared
        await deps.sendMessage(userId, PDPA_MESSAGES.EXPORT_STARTED);

        // Export all user data
        const exportData = await deps.dataGateway.exportUserData(userId);

        // Serialize to JSON buffer
        const jsonBuffer = Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8');

        // Upload to S3 and get download URL
        const downloadUrl = await deps.uploadExport(userId, jsonBuffer);

        // Send download link
        const response = PDPA_MESSAGES.EXPORT_READY(downloadUrl);
        await deps.sendMessage(userId, response);

        return { handled: true, response };
    } catch (error) {
        await deps.sendMessage(userId, PDPA_MESSAGES.EXPORT_FAILED);
        return { handled: true, response: PDPA_MESSAGES.EXPORT_FAILED };
    }
}

/**
 * Handle the /deleteaccount command.
 * Asks for confirmation before proceeding with deletion.
 */
async function handleDeleteAccountCommand(
    userId: string,
    deps: PdpaDependencies,
): Promise<PdpaCommandResult> {
    // Enter deletion confirmation flow
    pendingDeletions.set(userId, new Date().toISOString());

    await deps.sendMessage(userId, PDPA_MESSAGES.DELETE_CONFIRM);
    return { handled: true, response: PDPA_MESSAGES.DELETE_CONFIRM };
}

/**
 * Handle the user's response to the deletion confirmation prompt.
 */
async function handleDeletionConfirmation(
    userId: string,
    text: string,
    deps: PdpaDependencies,
): Promise<PdpaCommandResult> {
    // Always clear the pending state
    pendingDeletions.delete(userId);

    if (text === 'confirm') {
        try {
            await deps.dataGateway.deleteAllUserData(userId);
            await deps.sendMessage(userId, PDPA_MESSAGES.DELETE_SUCCESS);
            return { handled: true, response: PDPA_MESSAGES.DELETE_SUCCESS };
        } catch (error) {
            await deps.sendMessage(userId, PDPA_MESSAGES.DELETE_FAILED);
            return { handled: true, response: PDPA_MESSAGES.DELETE_FAILED };
        }
    }

    // Any other response (including 'cancel') cancels the deletion
    await deps.sendMessage(userId, PDPA_MESSAGES.DELETE_CANCELLED);
    return { handled: true, response: PDPA_MESSAGES.DELETE_CANCELLED };
}

/**
 * Handle the user's response to the consent request.
 */
async function handleConsentResponse(
    userId: string,
    text: string,
    deps: PdpaDependencies,
): Promise<PdpaCommandResult> {
    // Always clear the pending state
    pendingConsent.delete(userId);

    if (text === 'yes') {
        // Store consent in user preferences
        const existingPrefs = await deps.dataGateway.getUserPreference(userId);
        const prefs = existingPrefs ?? {
            autoSave: false,
            notificationTime: '09:00',
            slideTemplate: 'Corporate' as const,
            consentGiven: false,
        };

        await deps.dataGateway.putUserPreference(userId, {
            ...prefs,
            consentGiven: true,
            consentTimestamp: new Date().toISOString(),
        });

        await deps.sendMessage(userId, PDPA_MESSAGES.CONSENT_ACCEPTED);
        return { handled: true, response: PDPA_MESSAGES.CONSENT_ACCEPTED };
    }

    // 'no' or any other response = declined
    await deps.sendMessage(userId, PDPA_MESSAGES.CONSENT_DECLINED);
    return { handled: true, response: PDPA_MESSAGES.CONSENT_DECLINED };
}

// ── Testing utilities ──

/**
 * Check if a user has a pending deletion confirmation.
 * @internal Exposed for testing only.
 */
export function hasPendingDeletion(userId: string): boolean {
    return pendingDeletions.has(userId);
}

/**
 * Check if a user is in the consent flow.
 * @internal Exposed for testing only.
 */
export function hasPendingConsent(userId: string): boolean {
    return pendingConsent.has(userId);
}

/**
 * Clear all pending state. Used in tests.
 * @internal
 */
export function clearPendingState(): void {
    pendingDeletions.clear();
    pendingConsent.clear();
}
