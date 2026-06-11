/**
 * Fire-now smoke test: loads Clawd wiring and exercises the digest path
 * end-to-end (mnemon recall + bedrock + delivery resolution) WITHOUT actually
 * sending a Telegram message. We monkey-patch the delivery adapter to print
 * what would have been sent.
 *
 * Run from repo root:
 *   node --env-file=.env scripts/smoke-digest.mjs
 */
import { setDeliveryAdapter, getDeliveryAdapter } from '../dist/delivery.js';
import { initDb } from '../dist/db/connection.js';
import * as path from 'node:path';

// Initialize the central DB so queries work
const DB_PATH = process.env.NANOCLAW_DB || path.join(process.env.LOG_PATH ? path.dirname(process.env.LOG_PATH) : process.cwd(), 'data', 'v2.db');
const actualDbPath = process.env.NANOCLAW_DB || 'X:\\01 REPOSITORIES\\clawd\\data\\v2.db';
initDb(actualDbPath);
console.log('[smoke] DB initialized:', actualDbPath);


// Inject a fake delivery adapter that just prints.
const fake = {
  async deliver(payload) {
    console.log('[smoke] WOULD DELIVER →', JSON.stringify({
      messaging_group_id: payload.messaging_group_id,
      channel_type: payload.channel_type,
      content_preview: (payload.content ?? '').slice(0, 200),
      content_chars: (payload.content ?? '').length,
    }, null, 2));
    return { ok: true };
  },
};

setDeliveryAdapter(fake);
console.log('[smoke] Fake delivery adapter installed.');

// Now load wiring (registers handlers via side-effects).
await import('../dist/modules/index.js');
console.log('[smoke] Modules loaded.');

// Wait a tick for any onDeliveryAdapterReady handlers to wire up.
await new Promise((r) => setTimeout(r, 100));

// Load clawd module to access the registered digest callback.
const pc = await import('../dist/modules/clawd.js');

// We can't directly call runMorningDigest (module-private). But we can fire
// the callback the wiring set via setDigestHandler — which is what the cron
// would invoke. The wiring registers it on import; we just need to call
// runMorningDigest by triggering the cron driver. Easier: re-export the
// callback via a module-level symbol... no, simpler: call setDigestHandler
// with a wrapping function that invokes the original; but we don't have a
// handle to the original.
//
// Since the wiring exports its runDigest function, just call
// THAT directly — it's the same function the digest handler runs.
const wiring = await import('../dist/modules/clawd-wiring.js');
console.log('[smoke] Available exports:', Object.keys(wiring));

if (typeof wiring.runDigest === 'function') {
  console.log('[smoke] Calling runDigest()...');
  await wiring.runDigest();
  console.log('[smoke] DONE.');
} else {
  console.log('[smoke] runDigest not exported — checking exports...');
  console.log(JSON.stringify(Object.keys(wiring)));
}

process.exit(0);
