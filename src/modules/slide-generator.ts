/**
 * PocketClaw — Slide deck generator (PRD §17.5)
 *
 * Renders a structured outline to a real .pptx file via `pptxgenjs`.
 * Three styles: minimal, corporate, creative. Speaker notes per slide
 * are populated by the agent before calling `render`.
 *
 * Output: `vault/presentations/YYYY-MM-DD_<topic>.pptx`
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
// pptxgenjs ships CJS — import as default.
import pptxgen from 'pptxgenjs';
import { envPath } from './paths.js';

const VAULT_PATH = envPath('VAULT_PATH', 'vault');

export type SlideStyle = 'minimal' | 'corporate' | 'creative';

export interface SlideSpec {
  title: string;
  bullets: string[];
  /** Optional speaker notes; rendered into the .pptx notes pane. */
  notes?: string;
}

export interface SlideDeck {
  topic: string;
  author?: string;
  date: Date;
  style: SlideStyle;
  slides: SlideSpec[];
}

export interface SlidesResult {
  filePath: string;
}

const STYLE_PALETTES: Record<SlideStyle, { bg: string; title: string; body: string; accent: string }> = {
  minimal: { bg: 'FFFFFF', title: '111111', body: '333333', accent: '888888' },
  corporate: { bg: 'FFFFFF', title: '0B3D91', body: '222222', accent: '0B3D91' },
  creative: { bg: 'FFF8E7', title: 'B8336A', body: '2A2A2A', accent: 'C2A878' },
};

function safeSegment(input: string): string {
  return (
    input
      .normalize('NFKD')
      .replace(/[^\w\-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 80) || 'deck'
  );
}

export class SlideGenerator {
  async render(deck: SlideDeck): Promise<SlidesResult> {
    const palette = STYLE_PALETTES[deck.style];
    // pptxgenjs default export is callable as a constructor.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PptxCtor = (pptxgen as unknown) as { new (): any };
    const pptx = new PptxCtor();
    pptx.layout = 'LAYOUT_16x9';

    // Title slide
    {
      const s = pptx.addSlide();
      s.background = { color: palette.bg };
      s.addText(deck.topic, {
        x: 0.5,
        y: 1.5,
        w: 9,
        h: 1.5,
        fontSize: 40,
        bold: true,
        color: palette.title,
        align: 'center',
      });
      const meta = `${deck.date.toISOString().slice(0, 10)}${deck.author ? ` · ${deck.author}` : ''}`;
      s.addText(meta, {
        x: 0.5,
        y: 3.2,
        w: 9,
        h: 0.5,
        fontSize: 14,
        color: palette.accent,
        align: 'center',
      });
    }

    // Content slides
    for (const slide of deck.slides) {
      const s = pptx.addSlide();
      s.background = { color: palette.bg };
      s.addText(slide.title, {
        x: 0.5,
        y: 0.4,
        w: 9,
        h: 0.8,
        fontSize: 26,
        bold: true,
        color: palette.title,
      });
      const bulletText = slide.bullets.map((b) => ({ text: b, options: { bullet: true } }));
      s.addText(bulletText, {
        x: 0.7,
        y: 1.4,
        w: 8.6,
        h: 4,
        fontSize: 16,
        color: palette.body,
        valign: 'top',
      });
      if (slide.notes) s.addNotes(slide.notes);
    }

    const dir = path.join(VAULT_PATH, 'presentations');
    await fs.mkdir(dir, { recursive: true });
    const fname = `${deck.date.toISOString().slice(0, 10)}_${safeSegment(deck.topic)}.pptx`;
    const filePath = path.join(dir, fname);
    await pptx.writeFile({ fileName: filePath });
    return { filePath };
  }
}
