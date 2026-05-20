---
name: wiki
description: Generate or regenerate an Obsidian wiki entry for an entity from mnemon memory.
---

# /wiki — regenerate wiki entry

Usage:

```
/wiki <topic>
```

Action:

1. Take everything after `/wiki ` as the entity name.
2. Invoke `WikiGenerator.generateEntry({ entityName })` from `src/modules/wiki-generator.ts`.
3. Wiki file is written to `${VAULT_PATH}/wiki/<sanitized-name>.md` (overwrites if exists).
4. Reply with the file path and a one-line summary of what was generated.

Notes:

- Wiki entries are derived data — every regeneration overwrites the file.
- If no memory context exists for the entity, the generator emits a stub entry only (no hallucination).
