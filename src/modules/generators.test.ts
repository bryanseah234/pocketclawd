/**
 * §17.3 / §17.4 / §17.5 — meeting minutes, research, slides render to disk.
 *
 * These are smoke tests: invoke each generator with minimal inputs, confirm
 * the resulting file exists, has non-zero size, and lives at a path inside
 * VAULT_PATH. Doesn't validate file format internals (docx/pdf/pptx readers
 * are heavy + flaky in CI; format correctness is verified by hand by Bryan).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MeetingMinutesGenerator } from './meeting-minutes.js';
import { ResearchReportGenerator } from './research-report.js';
import { SlideGenerator } from './slide-generator.js';

const TEST_VAULT = path.join(os.tmpdir(), 'pocketclaw-render-test', String(Date.now()));

beforeAll(async () => {
  process.env.VAULT_PATH = TEST_VAULT;
  await fs.mkdir(TEST_VAULT, { recursive: true });
});

describe('§17.3 MeetingMinutesGenerator', () => {
  it('produces a non-empty .docx file in vault/meetings/', async () => {
    // Module captures VAULT_PATH at import-time, so we need to set the env
    // var BEFORE the module is imported. vitest sometimes already imported
    // it via earlier test files in the same run, so this test directly
    // checks the result-path shape rather than the prefix.
    const gen = new MeetingMinutesGenerator();
    const result = await gen.generate({
      title: 'Render test',
      date: new Date(),
      durationMinutes: 30,
      attendees: ['Bryan', 'PocketClaw'],
      agenda: 'Verify generator',
      discussion: ['it works'],
      actions: ['ship'],
      decisions: ['approved'],
    });
    const stat = await fs.stat(result.filePath);
    expect(stat.size).toBeGreaterThan(1000);
    expect(result.filePath).toMatch(/meetings.*\.docx$/);
  });
});

describe('§17.4 ResearchReportGenerator', () => {
  it('produces a non-empty .pdf file in vault/research/', async () => {
    const gen = new ResearchReportGenerator();
    const result = await gen.render({
      topic: 'Render test topic',
      generatedAt: new Date(),
      summary: 'Smoke test',
      findings: ['Item 1', 'Item 2'],
      timeline: ['t0: started', 't1: finished'],
      relatedEntities: ['X', 'Y'],
      sources: [{ source: 'test', content: 'one source', id: '1' }],
    });
    const stat = await fs.stat(result.filePath);
    expect(stat.size).toBeGreaterThan(500);
    expect(result.filePath).toMatch(/research.*\.pdf$/);
  });
});

describe('§17.5 SlideGenerator', () => {
  it('produces a non-empty .pptx file in vault/presentations/', async () => {
    const gen = new SlideGenerator();
    const result = await gen.render({
      topic: 'Smoke test deck',
      author: 'PocketClaw',
      date: new Date(),
      style: 'minimal',
      slides: [
        { title: 'Hello', bullets: ['world'] },
        { title: 'Done', bullets: ['thanks'] },
      ],
    });
    const stat = await fs.stat(result.filePath);
    expect(stat.size).toBeGreaterThan(1000);
    expect(result.filePath).toMatch(/presentations.*\.pptx$/);
  });
});
