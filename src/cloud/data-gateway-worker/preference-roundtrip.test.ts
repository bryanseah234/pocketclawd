/**
 * Property-based test: Preference storage round-trip
 *
 * Feature: clawd-bot-persona, Property 2: Preference storage round-trip
 *
 * For any valid UserPreferences object, storing via `put_user_preference` and
 * retrieving via `get_user_preference` returns identical `technical_depth`,
 * `primary_domain`, and `discoveryCompleted` values without corrupting
 * pre-existing fields.
 *
 * **Validates: Requirements 1.3, 9.1**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import type { UserPreferences } from '../data-gateway/types.js';

// ── Arbitraries ──

const technicalDepthArb = fc.constantFrom('detailed', 'high-level') as fc.Arbitrary<'detailed' | 'high-level'>;
const primaryDomainArb = fc.constantFrom('frontend', 'infrastructure', 'data') as fc.Arbitrary<'frontend' | 'infrastructure' | 'data'>;
const slideTemplateArb = fc.constantFrom('Corporate', 'Modern', 'Elegant', 'Informative') as fc.Arbitrary<UserPreferences['slideTemplate']>;

/** Constrained date arbitrary that produces valid ISO strings. */
const isoDateArb = fc.integer({ min: 1577836800000, max: 1924905600000 }).map(ts => new Date(ts).toISOString());

/** Generates a valid full UserPreferences object (all fields populated). */
const fullPreferencesArb: fc.Arbitrary<UserPreferences> = fc.record({
    autoSave: fc.boolean(),
    notificationTime: fc.integer({ min: 0, max: 23 }).chain(h =>
        fc.integer({ min: 0, max: 59 }).map(m =>
            `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
        )
    ),
    slideTemplate: slideTemplateArb,
    consentGiven: fc.boolean(),
    consentTimestamp: fc.option(isoDateArb, { nil: undefined }),
    technical_depth: fc.option(technicalDepthArb, { nil: undefined }),
    primary_domain: fc.option(primaryDomainArb, { nil: undefined }),
    discoveryCompleted: fc.option(fc.boolean(), { nil: undefined }),
    discoveryCompletedAt: fc.option(isoDateArb, { nil: undefined }),
});

/**
 * Generates a partial preferences payload containing only defined persona fields.
 * Uses oneof to produce objects where persona fields are either present with valid
 * values or absent entirely (not set to undefined), matching real-world usage where
 * the discovery phase sends only the fields it wants to update.
 */
const personaFieldsArb: fc.Arbitrary<Partial<UserPreferences>> = fc.record(
    {
        technical_depth: technicalDepthArb,
        primary_domain: primaryDomainArb,
        discoveryCompleted: fc.boolean(),
        discoveryCompletedAt: isoDateArb,
    },
    { requiredKeys: [] },
);

// ── In-memory store simulating DynamoDB ──

function createMockDataGateway() {
    const store = new Map<string, UserPreferences>();

    return {
        store,
        async getUserPreference(userId: string): Promise<UserPreferences | null> {
            return store.get(userId) ?? null;
        },
        async putUserPreference(userId: string, prefs: UserPreferences): Promise<void> {
            store.set(userId, { ...prefs });
        },
    };
}

// ── Replicate handlePutUserPreference logic (from data-gateway-worker/index.ts) ──

const VALID_TECHNICAL_DEPTH = new Set(['detailed', 'high-level']);
const VALID_PRIMARY_DOMAIN = new Set(['frontend', 'infrastructure', 'data']);

async function handlePutUserPreference(
    gateway: ReturnType<typeof createMockDataGateway>,
    userId: string,
    preferences: Partial<UserPreferences> | undefined,
): Promise<void> {
    if (!userId) return;
    if (!preferences) return;

    // Validate persona enum fields before persisting
    if (preferences.technical_depth !== undefined && !VALID_TECHNICAL_DEPTH.has(preferences.technical_depth)) {
        return;
    }
    if (preferences.primary_domain !== undefined && !VALID_PRIMARY_DOMAIN.has(preferences.primary_domain)) {
        return;
    }

    // Merge with existing preferences (non-destructive)
    const existing = await gateway.getUserPreference(userId);
    const merged = { ...existing, ...preferences } as UserPreferences;

    await gateway.putUserPreference(userId, merged);
}

// ── Property Tests ──

describe('Feature: clawd-bot-persona, Property 2: Preference storage round-trip', () => {
    it('storing and retrieving persona fields preserves technical_depth, primary_domain, and discoveryCompleted', async () => {
        await fc.assert(
            fc.asyncProperty(
                personaFieldsArb,
                fc.string({ minLength: 1 }),
                async (personaFields, userId) => {
                    const gateway = createMockDataGateway();

                    // Store persona preferences
                    await handlePutUserPreference(gateway, userId, personaFields);

                    // Retrieve
                    const retrieved = await gateway.getUserPreference(userId);
                    expect(retrieved).not.toBeNull();

                    // Persona fields that were provided must match exactly
                    if ('technical_depth' in personaFields) {
                        expect(retrieved!.technical_depth).toBe(personaFields.technical_depth);
                    }
                    if ('primary_domain' in personaFields) {
                        expect(retrieved!.primary_domain).toBe(personaFields.primary_domain);
                    }
                    if ('discoveryCompleted' in personaFields) {
                        expect(retrieved!.discoveryCompleted).toBe(personaFields.discoveryCompleted);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });

    it('storing persona fields does not corrupt pre-existing preference fields', async () => {
        await fc.assert(
            fc.asyncProperty(
                fullPreferencesArb,
                personaFieldsArb,
                fc.string({ minLength: 1 }),
                async (existing, personaUpdate, userId) => {
                    const gateway = createMockDataGateway();

                    // Seed the store with existing preferences
                    await gateway.putUserPreference(userId, existing);

                    // Apply persona update via the handler
                    await handlePutUserPreference(gateway, userId, personaUpdate);

                    // Retrieve the result
                    const retrieved = await gateway.getUserPreference(userId);
                    expect(retrieved).not.toBeNull();

                    // Pre-existing non-persona fields must be preserved
                    expect(retrieved!.autoSave).toBe(existing.autoSave);
                    expect(retrieved!.notificationTime).toBe(existing.notificationTime);
                    expect(retrieved!.slideTemplate).toBe(existing.slideTemplate);
                    expect(retrieved!.consentGiven).toBe(existing.consentGiven);
                    expect(retrieved!.consentTimestamp).toBe(existing.consentTimestamp);

                    // Persona fields: incoming values overwrite, absent keys preserve existing
                    if ('technical_depth' in personaUpdate) {
                        expect(retrieved!.technical_depth).toBe(personaUpdate.technical_depth);
                    } else {
                        expect(retrieved!.technical_depth).toBe(existing.technical_depth);
                    }

                    if ('primary_domain' in personaUpdate) {
                        expect(retrieved!.primary_domain).toBe(personaUpdate.primary_domain);
                    } else {
                        expect(retrieved!.primary_domain).toBe(existing.primary_domain);
                    }

                    if ('discoveryCompleted' in personaUpdate) {
                        expect(retrieved!.discoveryCompleted).toBe(personaUpdate.discoveryCompleted);
                    } else {
                        expect(retrieved!.discoveryCompleted).toBe(existing.discoveryCompleted);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });
});
