/**
 * PocketClaw — host-side wiring for cron handlers.
 *
 * Imported for side effects from `src/modules/index.ts`.
 *
 * As of the pgvector / Claude-Code-subscription re-arch, host-side cron
 * handlers no longer invoke Claude directly:
 *
 *   - The wiki regen cron (03:00) needs a Claude callback. None is wired
 *     here, so `runWikiRegen` SKIPs with `no-provider`. Re-wiring through
 *     the agent container is a follow-on project.
 *
 *   - The morning digest cron (07:00) needs a delivery handler. None is
 *     wired here for the same reason; `runMorningDigest` SKIPs with
 *     `no-handler`.
 *
 * The adapter-ready audit is retained as a boot-chain signal so operators
 * can confirm the host wired up its delivery layer.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { onDeliveryAdapterReady } from '../delivery.js';
import { envPath } from './paths.js';

const LOG_PATH = envPath('LOG_PATH', 'logs');
const AUDIT_LOG = path.join(LOG_PATH, 'audit.log');

async function audit(line: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(AUDIT_LOG), { recursive: true });
    await fs.appendFile(AUDIT_LOG, `${new Date().toISOString()} | ${line}\n`, 'utf8');
  } catch {
    // best-effort; never fail caller
  }
}

onDeliveryAdapterReady(() => {
  void audit('POCKETCLAW_WIRING | delivery adapter ready (no host-side handlers wired)');
});
