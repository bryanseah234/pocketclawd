/* eslint-disable */
/**
 * PDPA compliance module types.
 * Requirements: REQ-7.3
 */

import type { IDataGateway, DeletionReceipt, UserDataExport } from '../data-gateway/types.js';

/** Result of handling a PDPA command. */
export type PdpaCommandResult =
    | { handled: true; response: string }
    | { handled: false };

/** Result of the consent check for new users. */
export type ConsentCheckResult =
    | { needsConsent: false }
    | { needsConsent: true; response: string };

/** Consent response from the user. */
export type ConsentResponse =
    | { accepted: true }
    | { accepted: false };

/** Configuration for the PDPA module. */
export interface PdpaConfig {
    /** S3 bucket for storing export files. */
    s3Bucket: string;
    /** Base URL for generating download links (e.g., pre-signed URL prefix). */
    exportUrlPrefix?: string;
    /** How long export links remain valid (seconds). Default: 86400 (24h). */
    exportLinkTtlSeconds?: number;
}

/** Pending deletion confirmation state. */
export interface PendingDeletion {
    userId: string;
    requestedAt: string;
}

/** Interface for the PDPA handler dependencies. */
export interface PdpaDependencies {
    dataGateway: IDataGateway;
    config: PdpaConfig;
    /** Send a text message to the user via WhatsApp. */
    sendMessage: (userId: string, text: string) => Promise<void>;
    /** Upload a buffer to S3 and return a download URL. */
    uploadExport: (userId: string, data: Buffer) => Promise<string>;
}

/** Messages used in the PDPA consent and command flows. */
export const PDPA_MESSAGES = {
    CONSENT_REQUEST:
        '🔒 *PDPA Consent Required*\n\n' +
        'Before I can assist you, I need your consent to store and process your personal data ' +
        'in accordance with the Personal Data Protection Act (PDPA).\n\n' +
        'Your data will be:\n' +
        '• Stored securely in Singapore (ap-southeast-1)\n' +
        '• Used only to provide AI assistant services\n' +
        '• Exportable at any time via /export\n' +
        '• Deletable at any time via /deleteaccount\n\n' +
        'Reply *yes* to consent, or *no* to decline.',

    CONSENT_ACCEPTED:
        '✅ Thank you! Your consent has been recorded. You can now use the assistant.\n\n' +
        'You can manage your data at any time:\n' +
        '• /export — Download all your data\n' +
        '• /deleteaccount — Delete all your data',

    CONSENT_DECLINED:
        '❌ Consent declined. I cannot store or process your data without consent. ' +
        'If you change your mind, send any message to start the consent process again.',

    EXPORT_STARTED:
        '📦 Preparing your data export. This may take a moment...',

    EXPORT_READY: (url: string) =>
        `✅ Your data export is ready!\n\n📥 Download: ${url}\n\n` +
        'This link is valid for 24 hours.',

    EXPORT_FAILED:
        '❌ Sorry, there was an error preparing your data export. Please try again later.',

    DELETE_CONFIRM:
        '⚠️ *Account Deletion*\n\n' +
        'This will permanently delete ALL your data including:\n' +
        '• Chat history\n' +
        '• Uploaded documents\n' +
        '• User preferences\n' +
        '• Indexed content\n\n' +
        'This action cannot be undone. Reply *confirm* to proceed or *cancel* to abort.',

    DELETE_SUCCESS:
        '✅ All your data has been permanently deleted. Your account has been removed.\n\n' +
        'If you message again in the future, you will need to provide consent again.',

    DELETE_CANCELLED:
        '👍 Account deletion cancelled. Your data remains unchanged.',

    DELETE_FAILED:
        '❌ Sorry, there was an error deleting your data. Please try again later.',
} as const;
