/**
 * Session Store types — interfaces for S3-backed WhatsApp session persistence.
 * Requirements: REQ-4.1, REQ-6.3
 */

export interface SessionStoreConfig {
    bucket: string;
    prefix: string;  // default 'sessions/'
    region: string;
}

export interface SessionHealthStatus {
    valid: boolean;
    lastChecked: string;  // ISO 8601
    expiresAt?: string;   // ISO 8601
}
