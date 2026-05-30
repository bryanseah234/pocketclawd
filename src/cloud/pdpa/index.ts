/**
 * PDPA Compliance Commands Module.
 *
 * Handles /export and /deleteaccount commands at the orchestrator level
 * (before routing to sub-agent). Also implements consent collection flow
 * for new users on first message.
 *
 * In-flight consent and deletion-confirmation state is held in an injected
 * PdpaFlowStore (Redis-backed in cloud mode, in-memory fallback otherwise),
 * so a mid-flow orchestrator restart no longer drops or duplicates a flow
 * (improvement #9 / t2-9).
 *
 * Requirements: REQ-7.3
 */

import { InMemoryPdpaFlowStore } from './flow-store.js';
import { PDPA_MESSAGES } from './types.js';

import type { PdpaFlowStore } from './flow-store.js';
import type {
    ConsentCheckResult,
    PdpaCommandResult,
    PdpaDependencies,
} from './types.js';

export { PDPA_MESSAGES } from './types.js';
export type { PdpaCommandResult, ConsentCheckResult, PdpaConfig, PdpaDependencies } from './types.js';
export type { PdpaFlowStore } from './flow-store.js';
export { RedisPdpaFlowStore, InMemoryPdpaFlowStore } from './flow-store.js';

/**
 * Process-local fallback store. Used only when no flowStore is injected.
 * This is the non-restart-safe path — cloud mode must inject a
 * RedisPdpaFlowStore via deps.flowStore.
 */
const fallbackStore = new InMemoryPdpaFlowStore();

function resolveStore(deps: PdpaDependencies): PdpaFlowStore {
    return deps.flowStore ?? fallbackStore;
}

export async function handlePdpaCommand(
    userId: string,
    messageText: string,
    deps: PdpaDependencies,
): Promise<PdpaCommandResult> {
    const store = resolveStore(deps);
    const text = messageText.trim().toLowerCase();

    if (await store.hasPendingDeletion(userId)) {
        return handleDeletionConfirmation(userId, text, deps, store);
    }

    if (await store.hasPendingConsent(userId)) {
        return handleConsentResponse(userId, text, deps, store);
    }

    if (text === '/export') {
        return handleExportCommand(userId, deps);
    }

    if (text === '/deleteaccount') {
        return handleDeleteAccountCommand(userId, deps, store);
    }

    return { handled: false };
}

export async function checkConsent(
    userId: string,
    deps: PdpaDependencies,
): Promise<ConsentCheckResult> {
    const store = resolveStore(deps);

    if (await store.hasPendingConsent(userId)) {
        return { needsConsent: false };
    }

    const prefs = await deps.dataGateway.getUserPreference(userId);

    if (prefs?.consentGiven) {
        return { needsConsent: false };
    }

    await store.setPendingConsent(userId);
    return {
        needsConsent: true,
        response: PDPA_MESSAGES.CONSENT_REQUEST,
    };
}

async function handleExportCommand(
    userId: string,
    deps: PdpaDependencies,
): Promise<PdpaCommandResult> {
    try {
        await deps.sendMessage(userId, PDPA_MESSAGES.EXPORT_STARTED);

        const exportData = await deps.dataGateway.exportUserData(userId);
        const jsonBuffer = Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8');
        const downloadUrl = await deps.uploadExport(userId, jsonBuffer);

        const response = PDPA_MESSAGES.EXPORT_READY(downloadUrl);
        await deps.sendMessage(userId, response);

        return { handled: true, response };
    } catch {
        await deps.sendMessage(userId, PDPA_MESSAGES.EXPORT_FAILED);
        return { handled: true, response: PDPA_MESSAGES.EXPORT_FAILED };
    }
}

async function handleDeleteAccountCommand(
    userId: string,
    deps: PdpaDependencies,
    store: PdpaFlowStore,
): Promise<PdpaCommandResult> {
    await store.setPendingDeletion(userId, new Date().toISOString());
    await deps.sendMessage(userId, PDPA_MESSAGES.DELETE_CONFIRM);
    return { handled: true, response: PDPA_MESSAGES.DELETE_CONFIRM };
}

async function handleDeletionConfirmation(
    userId: string,
    text: string,
    deps: PdpaDependencies,
    store: PdpaFlowStore,
): Promise<PdpaCommandResult> {
    await store.clearPendingDeletion(userId);

    if (text === 'confirm') {
        try {
            await deps.dataGateway.deleteAllUserData(userId);
            await deps.sendMessage(userId, PDPA_MESSAGES.DELETE_SUCCESS);
            return { handled: true, response: PDPA_MESSAGES.DELETE_SUCCESS };
        } catch {
            await deps.sendMessage(userId, PDPA_MESSAGES.DELETE_FAILED);
            return { handled: true, response: PDPA_MESSAGES.DELETE_FAILED };
        }
    }

    await deps.sendMessage(userId, PDPA_MESSAGES.DELETE_CANCELLED);
    return { handled: true, response: PDPA_MESSAGES.DELETE_CANCELLED };
}

async function handleConsentResponse(
    userId: string,
    text: string,
    deps: PdpaDependencies,
    store: PdpaFlowStore,
): Promise<PdpaCommandResult> {
    await store.clearPendingConsent(userId);

    if (text === 'yes') {
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

    await deps.sendMessage(userId, PDPA_MESSAGES.CONSENT_DECLINED);
    return { handled: true, response: PDPA_MESSAGES.CONSENT_DECLINED };
}

// -- Testing utilities --

export function hasPendingDeletion(userId: string): boolean {
    return fallbackStore.hasPendingDeletionSync(userId);
}

export function hasPendingConsent(userId: string): boolean {
    return fallbackStore.hasPendingConsentSync(userId);
}

export function clearPendingState(): void {
    fallbackStore.clearAllSync();
}
