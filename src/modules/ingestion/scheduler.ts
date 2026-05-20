/**
 * PocketClaw — Cloud ingestion scheduler (PRD §7.9.4)
 *
 * Runs every cloud ingester in parallel with fault isolation: one source
 * failing does not block the others. Returns a per-source IngestSummary.
 *
 * Caller is responsible for piping the produced facts into mnemon (typically
 * via a `mnemon remember` call per fact).
 */

import { spawn } from 'node:child_process';
import { googleIngesters } from './google.js';
import { microsoftIngesters } from './microsoft.js';
import { appleIngesters } from './apple.js';
import type { CloudIngester, Fact, IngestResult } from './types.js';

export interface IngestSummary {
  startedAt: Date;
  finishedAt: Date;
  results: IngestResult[];
  totalFacts: number;
  totalErrors: number;
}

const ALL_INGESTERS: CloudIngester[] = [
  ...googleIngesters,
  ...microsoftIngesters,
  ...appleIngesters,
];

export interface RunOptions {
  since?: Date;
  /** Custom subset of ingesters (defaults to all 9). */
  ingesters?: CloudIngester[];
  /** Receives every fact produced. Default: pipe to `mnemon remember`. */
  onFact?: (fact: Fact) => void | Promise<void>;
}

export class CloudScheduler {
  /**
   * Run every ingester in parallel using `Promise.allSettled` so one
   * failure does not abort the others.
   */
  async runAll(options: RunOptions = {}): Promise<IngestSummary> {
    const since = options.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const ingesters = options.ingesters ?? ALL_INGESTERS;
    const onFact = options.onFact ?? defaultOnFact;
    const startedAt = new Date();

    const settled = await Promise.allSettled(
      ingesters.map((ing) => runOne(ing, since, onFact)),
    );

    const results: IngestResult[] = settled.map((s, i) => {
      const ing = ingesters[i]!;
      if (s.status === 'fulfilled') return s.value;
      return {
        source: ing.source,
        factsCount: 0,
        errors: [s.reason instanceof Error ? s.reason.message : String(s.reason)],
        durationMs: 0,
      };
    });

    return {
      startedAt,
      finishedAt: new Date(),
      results,
      totalFacts: results.reduce((acc, r) => acc + r.factsCount, 0),
      totalErrors: results.reduce((acc, r) => acc + r.errors.length, 0),
    };
  }
}

async function runOne(
  ing: CloudIngester,
  since: Date,
  onFact: (f: Fact) => void | Promise<void>,
): Promise<IngestResult> {
  const start = Date.now();
  let factsCount = 0;
  const errors: string[] = [];

  try {
    const { facts, errors: ingestErrs } = await ing.fetch(since);
    errors.push(...ingestErrs);
    for (const f of facts) {
      try {
        await onFact(f);
        factsCount += 1;
      } catch (e) {
        errors.push(`onFact ${f.sourceId ?? f.source}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    // configuration error — surfaces as a single ingester failure
    errors.push((e as Error).message);
  }

  return {
    source: ing.source,
    factsCount,
    errors,
    durationMs: Date.now() - start,
  };
}

/**
 * Default fact handler: pipe to `mnemon remember`. Mnemon must be on PATH
 * (installed via `/add-mnemon`).
 */
async function defaultOnFact(fact: Fact): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = ['remember', fact.text, '--source', fact.source];
    if (fact.sourceId) args.push('--source-id', fact.sourceId);
    const proc = spawn('mnemon', args, { stdio: 'pipe' });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mnemon remember failed (${code}): ${stderr}`));
    });
  });
}

export const ALL_CLOUD_INGESTERS = ALL_INGESTERS;
