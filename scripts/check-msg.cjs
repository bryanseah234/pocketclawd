const Database = require('better-sqlite3');
const db = new Database('./data/v2-sessions/ag-1779335520163-gzrk2c/sess-1779335520533-f0aglt/inbound.db');
const cols = db.prepare("PRAGMA table_info(messages_in)").all();
console.log('Columns:', cols.map(c => c.name).join(', '));
const msgs = db.prepare('SELECT * FROM messages_in ORDER BY seq DESC LIMIT 3').all();
msgs.forEach(m => {
  const body = m.body ? String(m.body).substring(0, 80) : '';
  console.log(JSON.stringify({ seq: m.seq, status: m.status, kind: m.kind, tries: m.tries, body }));
});
