/**
 * scheduler — Promise.allSettled fault isolation across ingesters.
 *
 * Smoke test that uses a fake set of CloudIngester instances; the real
 * google/microsoft/etc. modules require live creds. Validates that one
 * ingester throwing does NOT abort the others, and that error surfacing
 * works correctly per-source.
 */
import { describe, it, expect } from 'vitest';
import { CloudScheduler } from './scheduler.js';
import type { CloudIngester } from './types.js';

class HappyIngester implements CloudIngester {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
  async fetch() {
    return {
      facts: [{ text: `fact from ${this.source}`, source: this.source, sourceId: '1' }],
      errors: [],
    };
  }
}

class FailingIngester implements CloudIngester {
  readonly source = 'broken-source';
  async fetch() {
    throw new Error('intentional test failure');
  }
}

class PartialIngester implements CloudIngester {
  readonly source = 'mostly-ok';
  async fetch() {
    return {
      facts: [{ text: 'one fact', source: this.source, sourceId: 'a' }],
      errors: ['warning: rate limited on second page'],
    };
  }
}

describe('CloudScheduler.runAll — fault isolation', () => {
  it('one source throwing does NOT block the others', async () => {
    const sched = new CloudScheduler();
    let called = 0;
    const summary = await sched.runAll({
      since: new Date(),
      ingesters: [new HappyIngester('a'), new FailingIngester(), new HappyIngester('b')],
      onFact: () => {
        called += 1;
      },
    });

    expect(summary.results).toHaveLength(3);
    expect(summary.totalFacts).toBe(2); // a + b succeeded
    expect(summary.totalErrors).toBeGreaterThanOrEqual(1);
    expect(called).toBe(2);
  });

  it('partial errors surface in IngestResult.errors', async () => {
    const sched = new CloudScheduler();
    const summary = await sched.runAll({
      since: new Date(),
      ingesters: [new PartialIngester()],
      onFact: () => {},
    });

    expect(summary.results[0]?.factsCount).toBe(1);
    expect(summary.results[0]?.errors).toContain('warning: rate limited on second page');
  });

  it('happy path: all ingesters return facts', async () => {
    const sched = new CloudScheduler();
    let count = 0;
    const summary = await sched.runAll({
      since: new Date(),
      ingesters: [new HappyIngester('x'), new HappyIngester('y'), new HappyIngester('z')],
      onFact: () => {
        count += 1;
      },
    });

    expect(summary.totalFacts).toBe(3);
    expect(summary.totalErrors).toBe(0);
    expect(count).toBe(3);
    expect(summary.results.map((r) => r.source).sort()).toEqual(['x', 'y', 'z']);
  });

  it('records per-source duration', async () => {
    const sched = new CloudScheduler();
    const summary = await sched.runAll({
      since: new Date(),
      ingesters: [new HappyIngester('timing-test')],
      onFact: () => {},
    });
    expect(summary.results[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary.results[0]?.durationMs).toBeLessThan(5000);
  });
});
