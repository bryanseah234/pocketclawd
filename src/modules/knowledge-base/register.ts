/**
 * Knowledge-base module — registers delivery action handlers.
 *
 * Sibling barrel for kb-actions.ts. Imported by src/modules/index.ts at
 * startup; the registerDeliveryAction call below wires the host-side handler
 * for `kb_request` system actions emitted by in-container kb_* MCP tools.
 *
 * The KB interface (`./index.ts`) is intentionally NOT a registration site —
 * it stays free of host-runtime coupling so unit tests can import the
 * interface without dragging in delivery.ts.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleKbRequest } from './kb-actions.js';

registerDeliveryAction('kb_request', handleKbRequest);
