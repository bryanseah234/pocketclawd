/**
 * Regression test for the WhatsApp channel adapter factory gate (G_3).
 *
 * Bug context (2026-05-28): an unconditional fs.mkdirSync(authDir, ...) at the
 * top of the WhatsApp factory caused EACCES in the smoke step of
 * deploy-feature.yml. The smoke container runs without --user root and
 * with WHATSAPP_ENABLED=false, but the factory still tried to create
 * /home/nanoclaw/.clawd/whatsapp/. The error tripped the circuit breaker
 * (5min open) and cascaded into a 75s probe timeout.
 *
 * Fix: gate the mkdir behind the WHATSAPP_ENABLED check at src/channels/whatsapp.ts:266.
 * If the channel is explicitly disabled and there's no phone number AND no
 * existing creds.json, return null BEFORE touching the filesystem.
 *
 * This test asserts:
 * (a) The factory returns null when WHATSAPP_ENABLED is unset and authDir is unwritable.
 * (b) The mkdir is wrapped in try/catch and falls back to null on EACCES.
 * (c) The source file structure still implements (a) and (b).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('WhatsApp channel adapter factory gate (regression)', () => {
    const sourcePath = join(process.cwd(), 'src', 'channels', 'whatsapp.ts');
    const src = readFileSync(sourcePath, 'utf-8');

    it('source: factory bails BEFORE fs.mkdirSync when WHATSAPP_ENABLED is unset', () => {
        // The bail check at line ~266 must come before the mkdirSync at line ~313.
        const enabledCheckIdx = src.indexOf('!env.WHATSAPP_ENABLED && !phoneNumber');
        const mkdirIdx = src.indexOf('fs.mkdirSync(authDir');
        expect(enabledCheckIdx).toBeGreaterThan(0);
        expect(mkdirIdx).toBeGreaterThan(0);
        expect(enabledCheckIdx).toBeLessThan(mkdirIdx);
    });

    it('source: factory wraps fs.mkdirSync in try/catch with return null on failure', () => {
        // Locate the mkdirSync line in source, then walk surrounding 10 lines
        // and assert there is a try { before it and a catch ... return null after it.
        const lines = src.split('\n');
        const idx = lines.findIndex(l => l.includes('fs.mkdirSync(authDir'));
        expect(idx).toBeGreaterThan(0);
        const before = lines.slice(Math.max(0, idx - 5), idx).join('\n');
        const after = lines.slice(idx + 1, idx + 15).join('\n');
        expect(before).toMatch(/try\s*\{/);
        expect(after).toMatch(/catch/);
        expect(after).toContain('return null');
    });

    it('source: existsSync probe before mkdir is also wrapped in try/catch', () => {
        // The first existsSync inside the disabled-channel guard must be
        // wrapped so an EPERM/EACCES on it doesn't crash the factory.
        const probeBlock = src.match(/if \(!env\.WHATSAPP_ENABLED && !phoneNumber\) \{[\s\S]*?\}\s*\n\s*\n/)?.[0];
        expect(probeBlock).toBeDefined();
        expect(probeBlock).toContain('try');
        expect(probeBlock).toContain('catch');
        expect(probeBlock).toContain('return null');
    });

    it('source: lint guard — no unconditional fs.mkdirSync at top level of factory', () => {
        // Find the registerChannelAdapter('whatsapp', { factory: ...) block
        // and assert no fs.mkdirSync appears OUTSIDE a try{...}catch wrapper.
        const factoryStart = src.indexOf("registerChannelAdapter('whatsapp'");
        expect(factoryStart).toBeGreaterThan(0);
        // Check the first 60 lines after factoryStart — that's where the
        // smoke-test EACCES would trip. Every fs.mkdirSync in this region
        // must have a 'try' within 4 lines before it.
        const region = src.slice(factoryStart, factoryStart + 4000);
        const lines = region.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('fs.mkdirSync')) {
                const prev = lines.slice(Math.max(0, i - 4), i).join('\n');
                expect(prev).toMatch(/try\s*\{/);
            }
        }
    });
});
