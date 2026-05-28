/**
 * Tests for photo processor (PRD §11.1)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  validatePhoto,
  parseDescriptionResponse,
  ALLOWED_FORMATS,
  MAX_PHOTO_BYTES,
} from './photo-processor.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawd-photo-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(name: string, sizeBytes: number): Promise<string> {
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, Buffer.alloc(sizeBytes, 0xff));
  return file;
}

describe('validatePhoto', () => {
  it('accepts JPEG', async () => {
    const f = await writeFile('photo.jpg', 1024);
    expect((await validatePhoto(f)).valid).toBe(true);
  });

  it('accepts PNG', async () => {
    const f = await writeFile('photo.png', 1024);
    expect((await validatePhoto(f)).valid).toBe(true);
  });

  it('accepts WebP', async () => {
    const f = await writeFile('photo.webp', 1024);
    expect((await validatePhoto(f)).valid).toBe(true);
  });

  it('accepts uppercase JPEG extension', async () => {
    const f = await writeFile('photo.JPEG', 1024);
    expect((await validatePhoto(f)).valid).toBe(true);
  });

  it('rejects MP4', async () => {
    const f = await writeFile('video.mp4', 1024);
    const r = await validatePhoto(f);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('Unsupported');
  });

  it('rejects PDF', async () => {
    const f = await writeFile('doc.pdf', 1024);
    expect((await validatePhoto(f)).valid).toBe(false);
  });

  it('rejects GIF', async () => {
    const f = await writeFile('animation.gif', 1024);
    expect((await validatePhoto(f)).valid).toBe(false);
  });

  it('rejects files > 10MB', async () => {
    const f = await writeFile('huge.jpg', MAX_PHOTO_BYTES + 1);
    const r = await validatePhoto(f);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('10MB');
  });

  it('rejects empty files', async () => {
    const f = await writeFile('zero.jpg', 0);
    const r = await validatePhoto(f);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('empty');
  });

  it('rejects non-existent file', async () => {
    const r = await validatePhoto(path.join(tmpDir, 'missing.jpg'));
    expect(r.valid).toBe(false);
  });
});

describe('parseDescriptionResponse', () => {
  it('parses well-formed response', () => {
    const raw = [
      'Image Description: A whiteboard with sticky notes in three columns',
      'Extracted Text: Q3 Planning, API Integration',
      'Key Elements: whiteboard, sticky notes, marker',
      'Related Context: Project planning meeting',
    ].join('\n');

    const out = parseDescriptionResponse(raw);
    expect(out.description).toContain('whiteboard');
    expect(out.extractedText).toContain('Q3 Planning');
    expect(out.keyElements).toEqual(['whiteboard', 'sticky notes', 'marker']);
  });

  it('handles "none" extractedText', () => {
    const raw = [
      'Image Description: A blue sky',
      'Extracted Text: none',
      'Key Elements: sky',
    ].join('\n');
    const out = parseDescriptionResponse(raw);
    expect(out.extractedText).toBeUndefined();
  });

  it('falls back to raw text if no labels match', () => {
    const out = parseDescriptionResponse('Just a free-form description');
    expect(out.description).toBe('Just a free-form description');
  });
});

describe('ALLOWED_FORMATS', () => {
  it('contains exactly the four supported types', () => {
    expect(Array.from(ALLOWED_FORMATS).sort()).toEqual([
      '.jpeg',
      '.jpg',
      '.png',
      '.webp',
    ]);
  });
});
