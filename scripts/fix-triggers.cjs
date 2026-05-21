const Database = require('better-sqlite3');
const db = new Database('./data/v2.db');

// Update WhatsApp Prawn Hub: require @pocketclaw trigger, drop non-matching messages
db.prepare("UPDATE messaging_group_agents SET engage_pattern = '@pocketclaw', ignored_message_policy = 'drop' WHERE id = 'mga-1779356591380-ghyp4q'").run();
console.log('Updated WhatsApp Prawn Hub: trigger=@pocketclaw, policy=drop');

// Verify all interaction points
const w = db.prepare(`
  SELECT mga.id, mg.channel_type, mg.platform_id, mg.name, mga.engage_pattern, mga.ignored_message_policy, mga.sender_scope
  FROM messaging_group_agents mga
  JOIN messaging_groups mg ON mga.messaging_group_id = mg.id
`).all();
console.log('\n=== All interaction points ===');
w.forEach(r => console.log(`  ${r.channel_type} | ${r.name || r.platform_id} | trigger: ${r.engage_pattern} | non-match: ${r.ignored_message_policy}`));
