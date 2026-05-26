/**
 * Types for the Admin Dashboard API responses.
 * Requirements: REQ-6.1 (monitoring and observability)
 */

import type { ComponentStatus } from '../health/types.js';

// ── WhatsApp Status ──

export interface WhatsAppStatus {
    connected: boolean;
    phoneNumber: string | null;
    lastActivity: string | null; // ISO 8601
    uptime: number | null; // seconds since connection
    state: 'connected' | 'disconnected' | 'connecting' | 'qr_pending';
}

export interface WhatsAppQrResponse {
    available: boolean;
    /** Base64-encoded PNG data URI, or null if not available */
    qrDataUrl: string | null;
    /** Raw QR text for debugging */
    qrText: string | null;
    message: string;
}

// ── System Health ──

export interface ServiceHealth {
    name: string;
    status: ComponentStatus;
    latencyMs?: number;
    message?: string;
    lastChecked: string; // ISO 8601
}

export interface SystemHealthResponse {
    overallStatus: ComponentStatus;
    uptime: number; // seconds
    timestamp: string; // ISO 8601
    services: ServiceHealth[];
}

// ── Active Containers ──

export interface ContainerInfo {
    containerId: string;
    userId: string;
    status: 'running' | 'stopped' | 'starting' | 'error';
    uptime: number; // seconds
    memoryUsageMb: number;
    cpuPercent: number;
    lastActivity: string; // ISO 8601
}

export interface ContainersResponse {
    total: number;
    containers: ContainerInfo[];
}

// ── Recent Messages ──

export interface RecentMessage {
    id: string;
    timestamp: string; // ISO 8601
    direction: 'inbound' | 'outbound';
    status: 'delivered' | 'processing' | 'failed' | 'queued';
    processingTimeMs?: number;
    /** Anonymized user identifier (first 8 chars of hash) */
    userHash: string;
}

export interface RecentMessagesResponse {
    messages: RecentMessage[];
    totalProcessed24h: number;
}

// ── Rate Limiting Stats ──

export interface UserRateInfo {
    userHash: string;
    messagesLastMinute: number;
    messagesLastHour: number;
    isThrottled: boolean;
}

export interface StatsResponse {
    globalMessagesPerMinute: number;
    globalMessagesPerHour: number;
    activeUsers: number;
    topUsers: UserRateInfo[];
    rateLimitHits24h: number;
}

// ── Dashboard data provider interface ──

/**
 * Interface that the orchestrator implements to provide live data
 * to the admin dashboard. This decouples the dashboard from specific
 * service implementations.
 */
export interface DashboardDataProvider {
    getWhatsAppStatus(): Promise<WhatsAppStatus>;
    getWhatsAppQr(): Promise<WhatsAppQrResponse>;
    disconnectWhatsApp(): Promise<{ success: boolean; message: string }>;
    reconnectWhatsApp(): Promise<{ success: boolean; message: string }>;
    getSystemHealth(): Promise<SystemHealthResponse>;
    getContainers(): Promise<ContainersResponse>;
    getRecentMessages(): Promise<RecentMessagesResponse>;
    getStats(): Promise<StatsResponse>;
}
