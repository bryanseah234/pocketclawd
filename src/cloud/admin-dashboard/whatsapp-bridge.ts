/**
 * WhatsApp Bridge — connects the Baileys WhatsApp adapter to the admin dashboard SSE stream.
 *
 * The adapter calls setQrCode() / setWhatsAppConnected() / setWhatsAppDisconnected()
 * and the dashboard reads the current state via getWhatsAppState().
 *
 * Requirements: REQ-6.1 (monitoring and observability)
 */

import QRCode from 'qrcode';

// ── Types ──

export interface WhatsAppBridgeState {
    status: 'disconnected' | 'connecting' | 'qr_pending' | 'connected';
    phoneNumber: string | null;
    qrText: string | null;
    qrDataUrl: string | null;
    qrGeneratedAt: number | null; // epoch ms
    connectedAt: number | null; // epoch ms
}

// ── State ──

const state: WhatsAppBridgeState = {
    status: 'disconnected',
    phoneNumber: null,
    qrText: null,
    qrDataUrl: null,
    qrGeneratedAt: null,
    connectedAt: null,
};

// ── Public API (called by WhatsApp adapter) ──

/**
 * Called by the Baileys adapter when a new QR code is generated for pairing.
 * Converts the QR text to a PNG data URL for display in the dashboard.
 */
export async function setQrCode(qrText: string): Promise<void> {
    state.status = 'qr_pending';
    state.qrText = qrText;
    state.qrGeneratedAt = Date.now();
    state.phoneNumber = null;
    state.connectedAt = null;

    try {
        state.qrDataUrl = await QRCode.toDataURL(qrText, {
            width: 400,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
        });
    } catch {
        state.qrDataUrl = null;
    }
}

/**
 * Called by the Baileys adapter when the WhatsApp session connects successfully.
 */
export function setWhatsAppConnected(phoneNumber: string): void {
    state.status = 'connected';
    state.phoneNumber = phoneNumber;
    state.connectedAt = Date.now();
    state.qrText = null;
    state.qrDataUrl = null;
    state.qrGeneratedAt = null;
}

/**
 * Called by the Baileys adapter when the WhatsApp session disconnects.
 */
export function setWhatsAppDisconnected(): void {
    state.status = 'disconnected';
    state.phoneNumber = null;
    state.qrText = null;
    state.qrDataUrl = null;
    state.qrGeneratedAt = null;
    state.connectedAt = null;
}

/**
 * Returns the current WhatsApp bridge state for the SSE broadcast / API responses.
 */
export function getWhatsAppState(): WhatsAppBridgeState {
    return { ...state };
}
