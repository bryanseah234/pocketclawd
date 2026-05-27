/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 *
 * Cloud mode (NANOCLAW_ENV=cloud): initializes AWS services (Secrets Manager,
 * Data Gateway, Redis queue, rate limiter, CloudWatch logger) and uses Redis
 * for message passing instead of SQLite session DBs.
 */
import path from 'path';

import { backfillContainerConfigs } from './backfill-container-configs.js';
import { DATA_DIR } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import {
  isCloudMode,
  bootstrapCloudServices,
  shutdownCloudServices,
  startResponsePoll,
  stopResponsePoll,
  getCloudServices,
} from './cloud/bootstrap.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { routeInbound } from './router.js';
import { log } from './log.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

// Providers barrel — registers provider-specific container config (env passthrough,
// mounts).
import './providers/index.js';

// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { startCliServer, stopCliServer } from './cli/socket-server.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting', { cloudMode: isCloudMode() });

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 0b. Cloud mode: initialize AWS services before anything else.
  // Secrets Manager → Data Gateway → Redis queue → rate limiter → CloudWatch logger
  if (isCloudMode()) {
    try {
      await bootstrapCloudServices();
      log.info('Cloud services initialized');
    } catch (err) {
      log.fatal('Cloud bootstrap failed', { err });
      process.exit(1);
    }
  }

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1c. Start HTTP server early (before channel adapters which may block)
  if (isCloudMode()) {
    const http = await import('node:http');
    const { handleAdminRequest, initAdminDashboard } = await import('./cloud/admin-dashboard/index.js');
    const { getWhatsAppState, setWhatsAppConnected, setWhatsAppDisconnected, setQrCode } = await import('./cloud/admin-dashboard/whatsapp-bridge.js');

    const services = getCloudServices();

    // Store bridge functions globally so we can wire them after channel adapters init
    (globalThis as any).__nanoclaw_wa_bridge = { setQrCode, setWhatsAppConnected, setWhatsAppDisconnected, getWhatsAppState };

    initAdminDashboard({
      provider: {
        getWhatsAppStatus: async () => {
          const state = getWhatsAppState();
          return {
            connected: state.status === 'connected',
            phoneNumber: state.phoneNumber,
            lastActivity: null,
            uptime: state.connectedAt ? Math.floor((Date.now() - state.connectedAt) / 1000) : null,
            state: state.status,
          };
        },
        getWhatsAppQr: async () => {
          const state = getWhatsAppState();
          return {
            available: !!state.qrDataUrl,
            qrDataUrl: state.qrDataUrl,
            qrText: state.qrText,
            message: state.status === 'qr_pending' ? 'Scan QR code' : state.status === 'connected' ? 'Connected' : 'Not connected',
          };
        },
        disconnectWhatsApp: async () => {
          const adapter = getChannelAdapter('whatsapp');
          if (adapter) { await adapter.teardown(); setWhatsAppDisconnected(); return { success: true, message: 'Disconnected' }; }
          return { success: false, message: 'WhatsApp adapter not found' };
        },
        reconnectWhatsApp: async () => {
          const adapter = getChannelAdapter('whatsapp');
          if (adapter) { try { await adapter.teardown(); setWhatsAppDisconnected(); } catch { } return { success: true, message: 'Reconnecting...' }; }
          return { success: false, message: 'WhatsApp adapter not found' };
        },
        getSystemHealth: async () => {
          const health = services ? await services.healthCheck.getHealth() : null;
          return {
            overallStatus: (health?.status ?? 'unknown') as any,
            uptime: health?.uptime ?? 0,
            timestamp: new Date().toISOString(),
            services: health ? Object.entries(health.components).map(([name, c]) => ({ name, status: c.status, latencyMs: c.latencyMs, lastChecked: c.lastChecked ?? new Date().toISOString() })) : [],
          };
        },
        getContainers: async () => ({ total: 0, containers: [] }),
        getRecentMessages: async () => ({ messages: [], totalProcessed24h: 0 }),
        getStats: async () => ({ globalMessagesPerMinute: 0, globalMessagesPerHour: 0, activeUsers: 0, topUsers: [], rateLimitHits24h: 0 }),
      },
    });

    const server = http.createServer(async (req, res) => {
      // Landing page — served at GET / without authentication
      if (req.url === '/' && req.method === 'GET') {
        const { handleLandingPageRequest } = await import('./cloud/landing-page/index.js');
        handleLandingPageRequest(req, res);
        return;
      }

      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
      }
      const handled = await handleAdminRequest(req, res);
      if (handled) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(3000, '0.0.0.0', () => {
      log.info('HTTP server listening', { port: 3000, admin: '/admin' });
    });
  }

  // 1b. Backfill container_configs from legacy container.json files.
  // Idempotent — skips groups that already have a config row.
  backfillContainerConfigs();

  // 1c. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 5b. Cloud mode: start Redis response poll for sub-agent → orchestrator flow.
  // This replaces the SQLite outbound.db polling for cloud-managed containers.
  if (isCloudMode()) {
    const services = getCloudServices();
    if (services) {
      startResponsePoll(async (response) => {
        // Sub-agent response arrived via Redis — deliver through the channel adapter.
        const payload = response.payload;
        const channelType = payload.channelType as string | undefined;
        const platformId = payload.platformId as string | undefined;
        const threadId = (payload.threadId as string | null) ?? null;
        const kind = (payload.kind as string) ?? 'chat';
        const content = (payload.content as string) ?? JSON.stringify(payload);

        if (!channelType || !platformId) {
          log.warn('Cloud response missing routing fields', { responseId: response.id, userId: response.userId });
          return;
        }

        if (deliveryAdapter) {
          await deliveryAdapter.deliver(channelType, platformId, threadId, kind, content);
          log.info('Cloud response delivered', {
            responseId: response.id,
            userId: response.userId,
            channelType,
            platformId,
          });
        }
      });
      log.info('Cloud response poll started');
    }
  }

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 7. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  // 8. Wire WhatsApp adapter events into the admin dashboard bridge
  if (isCloudMode()) {
    const bridge = (globalThis as any).__nanoclaw_wa_bridge;
    const waAdapter = getChannelAdapter('whatsapp');
    if (waAdapter && bridge) {
      const wa = waAdapter as unknown as Record<string, unknown>;
      if (typeof wa.onQr === 'function') {
        (wa.onQr as (cb: (qr: string) => void) => void)((qr: string) => { void bridge.setQrCode(qr); });
      }
      if (typeof wa.onOpen === 'function') {
        (wa.onOpen as (cb: (phone: string) => void) => void)((phone: string) => { bridge.setWhatsAppConnected(phone); });
      }
      if (typeof wa.onClose === 'function') {
        (wa.onClose as (cb: () => void) => void)(() => { bridge.setWhatsAppDisconnected(); });
      }
      log.info('WhatsApp adapter hooked into admin dashboard bridge');
    }
  }

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopResponsePoll();
  stopHostSweep();
  await stopCliServer();

  // Shutdown cloud services (Redis, scheduler, health checks, etc.)
  if (isCloudMode()) {
    await shutdownCloudServices();
  }

  try {
    await teardownChannelAdapters();
  } finally {
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
