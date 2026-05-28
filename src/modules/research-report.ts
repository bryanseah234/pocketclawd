/* eslint-disable */
/**
 * Clawd — Local research report generator (PRD §17.4)
 *
 * Strict privacy invariant: this module pulls ONLY from local mnemon and
 * the user's vault. NO web search, NO outbound calls. The LLM (when
 * invoked by the calling skill) sees only the local context this module
 * gathered.
 *
 * Output: PDF written to `vault/research/YYYY-MM-DD_<topic>.pdf`.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
// pdfkit's published types are CommonJS; import as default.
import PDFDocument from 'pdfkit';
import { envPath } from './paths.js';
import { getKnowledgeBase } from './knowledge-base/index.js';

const VAULT_PATH = envPath('VAULT_PATH', 'vault');

export interface ResearchSource {
  /** Mnemon source tag (e.g. `gmail`, `outlook-mail`, `google-contacts`). */
  source: string;
  /** Cleaned content snippet. */
  content: string;
  /** Mnemon insight UUID for citation. */
  id: string;
  /** Created-at on the underlying fact. */
  occurredAt?: string;
}

export interface ResearchReport {
  topic: string;
  generatedAt: Date;
  /** Short prose summary the agent fills in; module just renders. */
  summary: string;
  /** Bulleted findings, each one ideally with an inline `[N]` citation. */
  findings: string[];
  /** Ordered timeline entries — each should be a short sentence. */
  timeline: string[];
  /** People / orgs / projects related. */
  relatedEntities: string[];
  /** Source list used for citation `[N]` indices. */
  sources: ResearchSource[];
}

export interface ResearchResult {
  filePath: string;
  bytes: number;
}

function safeSegment(input: string): string {
  return (
    input
      .normalize('NFKD')
      .replace(/[^\w\-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 80) || 'topic'
  );
}

/**
 * Pull every mnemon fact whose content matches `topic`. The mnemon CLI
 * returns JSON; we extract `content` + tags + id for citation.
 */
export async function gatherLocalSources(
  topic: string,
  limit = 80,
): Promise<{ sources: ResearchSource[]; errors: string[] }> {
  try {
    const kb = await getKnowledgeBase();
    const insights = await kb.recall(topic, { k: limit });
    const sources: ResearchSource[] = insights.map((ins) => ({
      // Prefer the insight's own `source` column; fall back to a `src:`
      // tag for legacy rows that predate the column being authoritative.
      source:
        ins.source ||
        ((ins.tags ?? []).find((t) => t.startsWith('src:')) ?? 'src:local').replace(/^src:/, ''),
      content: ins.text,
      id: String(ins.id ?? ''),
      occurredAt: ins.created_at?.toISOString(),
    }));
    return { sources, errors: [] };
  } catch (e) {
    return { sources: [], errors: [`kb recall: ${(e as Error).message}`] };
  }
}

export class ResearchReportGenerator {
  async render(report: ResearchReport): Promise<ResearchResult> {
    const dir = path.join(VAULT_PATH, 'research');
    await fs.mkdir(dir, { recursive: true });
    const fname = `${report.generatedAt.toISOString().slice(0, 10)}_${safeSegment(report.topic)}.pdf`;
    const filePath = path.join(dir, fname);

    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const stream = fsSync.createWriteStream(filePath);
      stream.on('finish', () => resolve());
      stream.on('error', reject);
      doc.pipe(stream);

      doc.fontSize(20).text(report.topic, { align: 'center' });
      doc.moveDown(0.3);
      doc
        .fontSize(10)
        .fillColor('#666')
        .text(
          `Generated ${report.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} — local sources only, no web search`,
          { align: 'center' },
        );
      doc.fillColor('black').moveDown(1);

      doc.fontSize(14).text('Executive Summary', { underline: true });
      doc.fontSize(11).moveDown(0.3).text(report.summary || '(no summary provided)');
      doc.moveDown(1);

      if (report.findings.length) {
        doc.fontSize(14).text('Key Findings', { underline: true });
        doc.fontSize(11).moveDown(0.3);
        for (const f of report.findings) doc.text(`• ${f}`);
        doc.moveDown(1);
      }

      if (report.timeline.length) {
        doc.fontSize(14).text('Timeline', { underline: true });
        doc.fontSize(11).moveDown(0.3);
        for (const t of report.timeline) doc.text(`• ${t}`);
        doc.moveDown(1);
      }

      if (report.relatedEntities.length) {
        doc.fontSize(14).text('Related Entities', { underline: true });
        doc.fontSize(11).moveDown(0.3).text(report.relatedEntities.join(', '));
        doc.moveDown(1);
      }

      doc.fontSize(14).text('Sources', { underline: true });
      doc.fontSize(9).moveDown(0.3);
      report.sources.forEach((s, i) => {
        const dateStr = s.occurredAt ? s.occurredAt.slice(0, 10) : '';
        doc.text(`[${i + 1}] (${s.source}${dateStr ? ` ${dateStr}` : ''}) ${s.content.slice(0, 240)}`);
      });

      doc.end();
    });

    const stat = await fs.stat(filePath);
    return { filePath, bytes: stat.size };
  }
}
