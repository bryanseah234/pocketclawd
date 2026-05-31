/**
 * §17.5 — SlideGenerator renders a deck to disk.
 *
 * Smoke test: invoke the generator with minimal inputs, confirm the resulting
 * file exists, has non-zero size, and lives under VAULT_PATH. Doesn't validate
 * pptx internals (format correctness is verified by hand).
 *
 * NOTE: MeetingMinutesGenerator (§17.3) and ResearchReportGenerator (§17.4)
 * were hard-deleted with the local-mode surface (commit 8eb072f); their smoke
 * tests were removed here at the same time. SlideGenerator is the only one that
 * survives in the cloud build.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SlideGenerator } from './slide-generator.js';

const TEST_VAULT = path.join(
  os.tmpdir(),
  `clawd-render-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);

beforeAll(async () => {
  process.env.VAULT_PATH = TEST_VAULT;
  await fs.mkdir(TEST_VAULT, { recursive: true });
});

describe('§17.5 SlideGenerator', () => {
  it('produces a non-empty .pptx file in vault/presentations/', async () => {
    const gen = new SlideGenerator();
    const result = await gen.render({
      topic: 'Smoke test deck',
      author: 'Clawd',
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
