const Database = require('better-sqlite3');
const db = new Database('./data/v2.db');

// 1. Find WhatsApp "The Prawn Hub" platform ID from discovered groups
const mgGroups = db.prepare("SELECT id, channel_type, platform_id, display_name FROM messaging_groups WHERE channel_type = 'whatsapp'").all();
console.log('WhatsApp messaging groups in DB:', mgGroups.length);
const prawnHub = mgGroups.find(g => g.display_name && g.display_name.toLowerCase().includes('prawn'));
if (prawnHub) {
  console.log('Found Prawn Hub:', JSON.stringify(prawnHub));
} else {
  console.log('Prawn Hub not in DB yet. Listing first 10 WhatsApp groups:');
  mgGroups.slice(0, 10).forEach(g => console.log(' -', g.platform_id, '|', g.display_name));
}

// 2. Show current wirings
console.log('\n=== Current wirings ===');
const wirings = db.prepare(`
  SELECT mga.id, mg.channel_type, mg.platform_id, mg.display_name, mga.engage_mode, mga.engage_pattern
  FROM messaging_group_agents mga
  JOIN messaging_groups mg ON mga.messaging_group_id = mg.id
`).all();
wirings.forEach(w => console.log(' -', w.channel_type, '|', w.display_name || w.platform_id, '|', w.engage_mode, ':', w.engage_pattern));
