/**
 * Tests for `handleRecurrence` — specifically the timezone-aware cron
 * interpretation ported from v1 (src/v1/task-scheduler.ts).
 *
 * Core invariant: cron expressions are interpreted in the user's TIMEZONE,
 * not UTC. Without this, `"0 9 * * *"` fires at 09:00 UTC instead of 09:00
 * user-local — a recurring scheduling bug users can't diagnose.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { insertTask } from './db.js';
import { handleRecurrence } from './recurrence.js';
import type { Session } from '../../types.js';

// Per-run unique temp dir so parallel vitest workers never collide on a
// shared path (was __TEST_DIR, which races + resolves to X:\tmp on Windows).
const __TEST_DIR = vi.hoisted(() => {
  const p = require('node:path');
  const os = require('node:os');
  return p.join(os.tmpdir(), `nanoclaw-recurrence-test-` + process.pid + '-' + Math.random().toString(36).slice(2));
});


const TEST_DIR = __TEST_DIR;
let __dbSeq = 0;

function freshDb() {
  // Unique DB file per call: avoids deleting a file whose handle is still open
  // (Windows locks open files -> EPERM/stale-data). Each freshDb() is fully isolated.
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const dbPath = path.join(TEST_DIR, `inbound-${__dbSeq++}.db`);
  ensureSchema(dbPath, 'inbound');
  return openInboundDb(dbPath);
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: 'mg-test',
    thread_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    container_status: 'stopped',
  } as Session;
}

afterEach(() => {
  try {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* best-effort: unique per-run dir, OS temp reaper handles any locked leftover */
  }
});

describe('handleRecurrence', () => {
  it('clones a completed recurring task with a next-run in the future', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *', // every day at 09:00 (user TZ)
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'daily digest' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();

    await handleRecurrence(db, fakeSession());

    const rows = db
      .prepare(`SELECT id, status, process_after, recurrence, series_id FROM messages_in ORDER BY seq`)
      .all() as Array<{
      id: string;
      status: string;
      process_after: string;
      recurrence: string | null;
      series_id: string;
    }>;
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.id === 'task-1')!;
    const follow = rows.find((r) => r.id !== 'task-1')!;
    expect(original.recurrence).toBeNull();
    expect(follow.status).toBe('pending');
    expect(follow.recurrence).toBe('0 9 * * *');
    expect(follow.series_id).toBe('task-1');
    expect(new Date(follow.process_after).getTime()).toBeGreaterThan(Date.now());
  });

  it('does not clone rows whose recurrence is already cleared', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'one-off' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();

    await handleRecurrence(db, fakeSession());

    const count = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(1);
  });
});
