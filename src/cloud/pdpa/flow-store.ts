/**
 * PDPA flow store — restart-safe persistence for in-flight consent and
 * deletion-confirmation flows.
 *
 * Previously these were in-process Maps (pendingDeletions / pendingConsent)
 * that were lost on orchestrator restart, causing duplicate consent prompts
 * or orphaned deletion confirmations (improvement #9 / t2-9).
 *
 * This store backs them with Redis using native key TTL:
 *   pdpa:pending-deletion:{userId}  EX 86400  (24h — confirm window)
 *   pdpa:pending-consent:{userId}   EX 86400  (24h — consent window)
 *
 * If no Redis client is supplied, an in-memory fallback is used (preserves
 * existing unit-test behavior and local/degraded operation).
 */

import type { Redis } from 'ioredis';

const DELETION_TTL_SECONDS = 86_400; // 24h
const CONSENT_TTL_SECONDS = 86_400; // 24h

const DELETION_PREFIX = 'pdpa:pending-deletion:';
const CONSENT_PREFIX = 'pdpa:pending-consent:';

export interface PdpaFlowStore {
    setPendingDeletion(userId: string, requestedAt: string): Promise<void>;
    hasPendingDeletion(userId: string): Promise<boolean>;
    clearPendingDeletion(userId: string): Promise<void>;

    setPendingConsent(userId: string): Promise<void>;
    hasPendingConsent(userId: string): Promise<boolean>;
    clearPendingConsent(userId: string): Promise<void>;

    /** Clear ALL flow state — test helper. */
    clearAll(): Promise<void>;
}

// ── Redis-backed implementation ──

export class RedisPdpaFlowStore implements PdpaFlowStore {
    constructor(private readonly redis: Redis) {}

    async setPendingDeletion(userId: string, requestedAt: string): Promise<void> {
        await this.redis.set(DELETION_PREFIX + userId, requestedAt, 'EX', DELETION_TTL_SECONDS);
    }
    async hasPendingDeletion(userId: string): Promise<boolean> {
        return (await this.redis.exists(DELETION_PREFIX + userId)) === 1;
    }
    async clearPendingDeletion(userId: string): Promise<void> {
        await this.redis.del(DELETION_PREFIX + userId);
    }

    async setPendingConsent(userId: string): Promise<void> {
        await this.redis.set(CONSENT_PREFIX + userId, '1', 'EX', CONSENT_TTL_SECONDS);
    }
    async hasPendingConsent(userId: string): Promise<boolean> {
        return (await this.redis.exists(CONSENT_PREFIX + userId)) === 1;
    }
    async clearPendingConsent(userId: string): Promise<void> {
        await this.redis.del(CONSENT_PREFIX + userId);
    }

    async clearAll(): Promise<void> {
        // Best-effort: scan + delete both prefixes. Used in tests/admin only.
        for (const prefix of [DELETION_PREFIX, CONSENT_PREFIX]) {
            let cursor = '0';
            do {
                const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
                cursor = next;
                if (keys.length > 0) await this.redis.del(...keys);
            } while (cursor !== '0');
        }
    }
}

// ── In-memory fallback (default when no Redis is supplied) ──

export class InMemoryPdpaFlowStore implements PdpaFlowStore {
    private deletions = new Map<string, string>();
    private consent = new Set<string>();

    async setPendingDeletion(userId: string, requestedAt: string): Promise<void> {
        this.deletions.set(userId, requestedAt);
    }
    async hasPendingDeletion(userId: string): Promise<boolean> {
        return this.deletions.has(userId);
    }
    async clearPendingDeletion(userId: string): Promise<void> {
        this.deletions.delete(userId);
    }

    async setPendingConsent(userId: string): Promise<void> {
        this.consent.add(userId);
    }
    async hasPendingConsent(userId: string): Promise<boolean> {
        return this.consent.has(userId);
    }
    async clearPendingConsent(userId: string): Promise<void> {
        this.consent.delete(userId);
    }

    async clearAll(): Promise<void> {
        this.deletions.clear();
        this.consent.clear();
    }

    // ── Synchronous introspection (test helpers only) ──
    hasPendingDeletionSync(userId: string): boolean {
        return this.deletions.has(userId);
    }
    hasPendingConsentSync(userId: string): boolean {
        return this.consent.has(userId);
    }
    clearAllSync(): void {
        this.deletions.clear();
        this.consent.clear();
    }
}
