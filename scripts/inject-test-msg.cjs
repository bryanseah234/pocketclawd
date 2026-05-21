const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const dbPath = './data/v2-sessions/ag-1779335520163-gzrk2c/sess-1779335520533-f0aglt/inbound.db';
const db = new Database(dbPath);

// Insert a fresh test message — use even seq (host-written)
const maxSeq = db.prepare('SELECT MAX(seq) as m FROM messages_in').get().m || 0;
const nextSeq = maxSeq + 2; // even = host

const id = crypto.randomUUID();
const now = new Date().toISOString();

db.prepare(`
  INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, tries, trigger, platform_id, channel_type, content, on_wake)
  VALUES (?, ?, 'message', ?, 'pending', ?, 0, 'always', 'telegram:-1003849817923', 'telegram', ?, 0)
`).run(id, nextSeq, now, now, JSON.stringify({
  type: 'text',
  text: 'hello pocketclaw',
  sender: { id: 'telegram:bryan', name: 'Bryan' },
  destinations: [{ name: 'the prawn hub', channel: 'telegram', platformId: 'telegram:-1003849817923' }]
}));

console.log('Inserted test message:', { id, seq: nextSeq, status: 'pending' });
console.log('Host sweep should pick this up within 60s');
