---
name: research
description: Generate a research report PDF from local mnemon facts only — strict no-web-search privacy invariant. Use when the user types `/research <topic>` or asks for a research summary.
---

# /research — Local Research Report (PRD §17.4)

## When to invoke

- User types: `/research <topic>` or `/research <topic> --location <path>`
- User asks: "summarize what I know about X", "research <topic> from my data"

## Privacy invariant

**NO web search. NO external APIs.** Only sources:
- Mnemon graph (every fact ever ingested)
- Watch path index (files indexed by file-watcher)
- Email threads in mnemon
- Calendar facts in mnemon

If the agent doesn't have enough local data, it should say so and stop — NOT fall back to web search.

## How it works

1. Call `gatherLocalSources(topic, limit=80)` to pull mnemon facts matching topic.
2. Group sources by source-tag (gmail, github, contacts, etc.).
3. Ask Claude to synthesize:
   - 2-3 paragraph executive summary citing `[N]` source indices
   - 5-10 key findings with citations
   - Timeline of events (chronological)
   - Related entities (people, orgs, projects mentioned)
4. Call `ResearchReportGenerator.render(report)` → produces PDF.
5. Save to `${VAULT_PATH}/research/YYYY-MM-DD_<topic>.pdf`.
6. Reply with summary + file path.

## Implementation

```ts
import { ResearchReportGenerator, gatherLocalSources } from '../../../src/modules/research-report.js';
const { sources } = await gatherLocalSources(topic, 80);
if (sources.length < 3) return `Not enough local data on "${topic}" — only ${sources.length} sources. Try ingesting more first via /ingest.`;
const report = {
  topic, generatedAt: new Date(),
  summary: summaryFromAgent,
  findings: findingsFromAgent,
  timeline: timelineFromAgent,
  relatedEntities: entitiesFromAgent,
  sources,
};
const result = await new ResearchReportGenerator().render(report);
return `Research report: ${result.filePath} (${result.bytes} bytes, ${sources.length} sources)`;
```

## Must-do

- Cite every claim with `[N]` referencing the sources list.
- If source count < 3, refuse and suggest `/ingest`.
- Save to `vault/research/`, never elsewhere.

## Must-not-do

- **NEVER call web search** (Tavily, Exa, perplexity, Google, etc).
- Never invent facts not in `sources`.
- Never include raw API tokens or session IDs in the output.
