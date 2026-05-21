/**
 * PocketClaw — LLM Wiki Generator (PRD §7.11)
 *
 * Pattern: Andrej Karpathy's LLM-supervised Wiki generation. Reads mnemon's
 * memory graph and emits structured Markdown wiki entries with WikiLink
 * cross-references into the Obsidian vault.
 *
 * Triggers (wired in T16 harness):
 *   - Manual: `/wiki <topic>` slash command
 *   - Scheduled: nightly at 03:00 (after cloud ingestion at 02:00)
 *   - Event-driven: after >10 new entities ingested
 *
 * The actual prompt sent to Claude Code is delegated to NanoClaw's provider
 * abstraction. This module owns:
 *   - mnemon recall to gather context
 *   - prompt construction (PRD §7.11 template, verbatim)
 *   - file write to vault/wiki/<entity>.md (overwrite by design)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { envPath } from './paths.js';

const VAULT_PATH = envPath('VAULT_PATH', 'vault');
const WIKI_DIR = path.join(VAULT_PATH, 'wiki');

export type EntityType = 'person' | 'organisation' | 'concept' | 'event' | 'project' | 'unknown';

export interface WikiEntryRequest {
  /** Canonical entity name as it appears in mnemon. */
  entityName: string;
  /** Best-guess entity type — used in YAML frontmatter. */
  entityType?: EntityType;
  /** Comma- or space-separated list of tags (snake_case enforced). */
  tags?: string[];
}

/** Build the wiki generation prompt — PRD §7.11 template, verbatim. */
export function buildWikiPrompt(
  entityName: string,
  mnemonRecallOutput: string,
): string {
  return `You are a personal knowledge curator for PocketClaw.

Generate a structured Obsidian-compatible Markdown wiki entry for the entity below.

Rules:
- Only include facts present in the memory context provided. No hallucination.
- Use [[WikiLink]] syntax for every related entity.
- Add YAML frontmatter: created, updated, entity_type, tags.
- Tags must use snake_case.
- If memory context is sparse, generate a short stub entry only.
- Output only the Markdown. No preamble.

Entity: ${entityName}
Memory context:
${mnemonRecallOutput}

Required structure:
---
created: ${new Date().toISOString().slice(0, 10)}
updated: ${new Date().toISOString().slice(0, 10)}
entity_type: {person|organisation|concept|event|project}
tags: [tag1, tag2]
---

# ${entityName}

## Summary
{2-4 sentence overview}

## Key Facts
{bullet list — sourced only from memory context}

## Relationships
{bullet list — use [[WikiLink]] for every entity}

## Timeline
{chronological events if available}

## Notes
{any additional context or caveats}
`;
}

/** Filesystem-safe filename: strip path separators, collapse to underscores. */
export function sanitizeEntityFilename(name: string): string {
  return name
    .trim()
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200);
}

/**
 * Run `mnemon recall` and return its raw stdout (intended for inclusion in
 * the wiki prompt as `Memory context`).
 */
export function recallEntity(entityName: string, depth = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('mnemon', [
      'recall',
      '--query',
      entityName,
      '--depth',
      String(depth),
      '--format',
      'json',
    ], { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c) => (stdout += String(c)));
    proc.stderr?.on('data', (c) => (stderr += String(c)));
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`mnemon recall failed (${code}): ${stderr}`));
    });
  });
}

/** List entities currently known to mnemon (default: top 100). */
export function listEntities(limit = 100): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn('mnemon', [
      'list',
      '--type',
      'entity',
      '--limit',
      String(limit),
      '--format',
      'plain',
    ], { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c) => (stdout += String(c)));
    proc.stderr?.on('data', (c) => (stderr += String(c)));
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
      } else {
        reject(new Error(`mnemon list failed (${code}): ${stderr}`));
      }
    });
  });
}

/**
 * Caller passes a `callClaude` function that takes the prompt and returns
 * the markdown body. This keeps the wiki generator framework-free; T16 wires
 * it to NanoClaw's provider abstraction.
 */
export type CallClaudeFn = (prompt: string) => Promise<string>;

export class WikiGenerator {
  constructor(
    private readonly callClaude: CallClaudeFn,
    private readonly options: {
      vaultDir?: string;
    } = {},
  ) {}

  /**
   * Generate (or regenerate) a single wiki entry. Always overwrites the
   * existing file — wiki entries are derived data, not user content.
   */
  async generateEntry(req: WikiEntryRequest): Promise<{ filePath: string; bytes: number }> {
    const recallOut = await recallEntity(req.entityName);
    const prompt = buildWikiPrompt(req.entityName, recallOut);
    const markdown = await this.callClaude(prompt);

    const wikiDir = this.options.vaultDir ?? WIKI_DIR;
    await fs.mkdir(wikiDir, { recursive: true });

    const filePath = path.join(wikiDir, `${sanitizeEntityFilename(req.entityName)}.md`);
    await fs.writeFile(filePath, markdown, 'utf8');
    return { filePath, bytes: Buffer.byteLength(markdown, 'utf8') };
  }

  /** Generate entries for every entity mnemon knows about. Parallel. */
  async generateAll(concurrency = 3): Promise<{
    succeeded: string[];
    failed: { entity: string; error: string }[];
  }> {
    const entities = await listEntities();
    const succeeded: string[] = [];
    const failed: { entity: string; error: string }[] = [];

    // simple bounded-parallel runner
    let cursor = 0;
    async function worker(this: WikiGenerator): Promise<void> {
      while (cursor < entities.length) {
        const idx = cursor++;
        const name = entities[idx]!;
        try {
          await this.generateEntry({ entityName: name });
          succeeded.push(name);
        } catch (e) {
          failed.push({ entity: name, error: (e as Error).message });
        }
      }
    }
    const workers = Array.from({ length: concurrency }, () => worker.call(this));
    await Promise.all(workers);

    return { succeeded, failed };
  }
}

export { VAULT_PATH, WIKI_DIR };
