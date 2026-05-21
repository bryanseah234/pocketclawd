/**
 * PocketClaw — Meeting minutes generator (PRD §17.3)
 *
 * Auto-generates structured meeting minutes from calendar events + email
 * threads stored in mnemon. Output: .docx file in `vault/meetings/`.
 *
 * Trigger paths:
 *  - Slash command: `/minutes [meeting-name]` — pulls most recent matching calendar fact
 *  - Auto: after each calendar event ends (if email threads exist for attendees)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  AlignmentType,
} from 'docx';
import { envPath } from './paths.js';

const VAULT_PATH = envPath('VAULT_PATH', 'vault');

export interface MeetingContext {
  title: string;
  date: Date;
  durationMinutes?: number;
  attendees: string[];
  agenda?: string;
  /** Related email/thread excerpts pulled from mnemon. */
  discussion: string[];
  actions: string[];
  decisions: string[];
}

export interface MinutesResult {
  filePath: string;
  bytes: number;
}

/**
 * Recall mnemon facts matching the meeting title and a 7-day window
 * around the event date.
 */
export async function gatherContextFromMnemon(
  meetingTitle: string,
): Promise<{ raw: string[]; errors: string[] }> {
  return new Promise((resolve) => {
    const proc = spawn(
      'mnemon',
      ['recall', meetingTitle, '--limit', '50'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('exit', () => {
      try {
        const parsed = JSON.parse(stdout) as {
          results?: Array<{ insight?: { content?: string } }>;
        };
        const raw = (parsed.results ?? [])
          .map((r) => r.insight?.content ?? '')
          .filter(Boolean);
        resolve({ raw, errors: stderr ? [stderr.trim()] : [] });
      } catch (e) {
        resolve({ raw: [], errors: [`mnemon recall parse: ${(e as Error).message}`] });
      }
    });
  });
}

function safeFileSegment(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80) || 'meeting';
}

function buildDocument(ctx: MeetingContext): Document {
  const heading = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]) =>
    new Paragraph({ heading: level, children: [new TextRun({ text, bold: true })] });
  const para = (text: string) => new Paragraph({ children: [new TextRun(text)] });
  const bullet = (text: string) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(text)] });

  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: ctx.title, bold: true })],
    }),
    para(`Date: ${ctx.date.toISOString().slice(0, 10)}`),
    ctx.durationMinutes ? para(`Duration: ${ctx.durationMinutes} minutes`) : para(''),
    heading('Attendees', HeadingLevel.HEADING_2),
    ...ctx.attendees.map(bullet),
  ];
  if (ctx.agenda) {
    children.push(heading('Agenda', HeadingLevel.HEADING_2), para(ctx.agenda));
  }
  if (ctx.discussion.length) {
    children.push(heading('Discussion', HeadingLevel.HEADING_2));
    children.push(...ctx.discussion.map(bullet));
  }
  if (ctx.actions.length) {
    children.push(heading('Action Items', HeadingLevel.HEADING_2));
    children.push(...ctx.actions.map(bullet));
  }
  if (ctx.decisions.length) {
    children.push(heading('Decisions', HeadingLevel.HEADING_2));
    children.push(...ctx.decisions.map(bullet));
  }

  return new Document({ sections: [{ children }] });
}

export class MeetingMinutesGenerator {
  /** Generate minutes from a fully-populated context. */
  async generate(ctx: MeetingContext): Promise<MinutesResult> {
    const doc = buildDocument(ctx);
    const buf = await Packer.toBuffer(doc);
    const dir = path.join(VAULT_PATH, 'meetings');
    await fs.mkdir(dir, { recursive: true });
    const fname = `${ctx.date.toISOString().slice(0, 10)}_${safeFileSegment(ctx.title)}.docx`;
    const filePath = path.join(dir, fname);
    await fs.writeFile(filePath, buf);
    return { filePath, bytes: buf.length };
  }

  /**
   * Pull mnemon facts and synthesize minimal context. The agent (Claude)
   * is expected to enrich agenda/discussion/actions/decisions via prompt;
   * this helper just gathers raw material.
   */
  async draftFromMnemon(meetingTitle: string, when: Date = new Date()): Promise<MeetingContext> {
    const { raw } = await gatherContextFromMnemon(meetingTitle);
    const attendees = Array.from(
      new Set(
        raw
          .flatMap((s) => s.match(/Contact ([^,]+),/g) ?? [])
          .map((s) => s.replace(/^Contact /, '').replace(/,$/, '')),
      ),
    ).slice(0, 12);
    return {
      title: meetingTitle,
      date: when,
      attendees,
      discussion: raw.slice(0, 10),
      actions: [],
      decisions: [],
    };
  }
}
