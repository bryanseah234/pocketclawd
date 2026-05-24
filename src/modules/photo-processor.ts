/**
 * PocketClaw — Photo Processing Pipeline (PRD §7.8)
 *
 * Pipeline: download → validate → resize → vision describe → mnemon
 * remember → delete cache.
 *
 * The original photo never leaves the cache. Only the description
 * survives in the memory graph.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getKnowledgeBase } from './knowledge-base/index.js';

/** Allowed image extensions (lower-case, with dot). */
export const ALLOWED_FORMATS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_PHOTO_PIXELS = 2048;
export const PHOTO_CACHE_DIR =
  process.env.PHOTO_CACHE_DIR ?? '/home/user/.photo-cache';

export interface PhotoValidation {
  valid: boolean;
  error?: string;
}

export interface PhotoDescription {
  description: string;
  extractedText?: string;
  keyElements?: string[];
}

/**
 * Validate a photo by extension + size. Returns `{valid: true}` or
 * `{valid: false, error: '...'}` so callers can produce a user-facing error
 * message without throwing.
 */
export async function validatePhoto(
  filePath: string,
): Promise<PhotoValidation> {
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_FORMATS.has(ext)) {
    return {
      valid: false,
      error: `Unsupported format ${ext}. Please send JPEG, PNG, or WebP.`,
    };
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { valid: false, error: 'Photo file does not exist.' };
  }

  if (stat.size > MAX_PHOTO_BYTES) {
    return {
      valid: false,
      error: `Photo exceeds 10MB limit (got ${(stat.size / 1024 / 1024).toFixed(1)}MB).`,
    };
  }
  if (stat.size === 0) {
    return { valid: false, error: 'Photo file is empty.' };
  }

  return { valid: true };
}

/**
 * Resize a photo so the longest edge ≤ 2048px, preserving aspect ratio.
 * Uses `sharp` (added as a dep when this skill is wired). If sharp is not
 * installed, the original path is returned unchanged.
 */
export async function resizePhoto(
  filePath: string,
  maxPx: number = MAX_PHOTO_PIXELS,
): Promise<string> {
  // Dynamic import so the module doesn't hard-require sharp at load time.
  // `sharp` is added as a dep but typed as `any` here so this file compiles
  // before pnpm install runs (CI/dev sandbox case).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sharp: any = null;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    // Sharp not installed yet — return original path (validation already passed).
    return filePath;
  }

  if (!sharp) return filePath;

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const outPath = path.join(dir, `${base}.resized${ext}`);

  await sharp(filePath)
    .resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true })
    .toFile(outPath);

  // Replace the original cache entry with the resized one to save space.
  await fs.unlink(filePath).catch(() => undefined);
  await fs.rename(outPath, filePath);

  return filePath;
}

/**
 * Generate a description for a photo using a local Ollama vision model
 * (default `llava`). Returns parsed `PhotoDescription`.
 */
export async function generateDescription(
  imagePath: string,
  userMessage: string,
  platform: string,
  options: {
    ollamaHost?: string;
    visionModel?: string;
  } = {},
): Promise<PhotoDescription> {
  const ollamaHost =
    options.ollamaHost ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const model = options.visionModel ?? process.env.VISION_MODEL ?? 'llava';

  const prompt = buildVisionPrompt(userMessage, platform);
  const imageBytes = await fs.readFile(imagePath);
  const imageBase64 = imageBytes.toString('base64');

  const response = await fetch(`${ollamaHost}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      images: [imageBase64],
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama vision call failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as { response?: string };
  const raw = json.response ?? '';
  return parseDescriptionResponse(raw);
}

/** Build the prompt sent to the vision model (PRD §7.8). */
function buildVisionPrompt(userMessage: string, platform: string): string {
  return [
    'You have received an image with the following context from the user.',
    '',
    `User message: "${userMessage}"`,
    `Platform: ${platform}`,
    '',
    'Task:',
    '1. Describe the image content concisely (2-3 sentences)',
    '2. Extract any text visible in the image',
    '3. Identify any people, objects, locations if recognizable',
    '4. Link to conversation context if relevant',
    '',
    'Output format (use exactly these labels):',
    'Image Description: <concise description>',
    'Extracted Text: <any text found, or "none">',
    'Key Elements: <comma-separated list of identifiable elements>',
    'Related Context: <how this connects to conversation, or "none">',
  ].join('\n');
}

/** Parse the vision-model response into a structured object. */
export function parseDescriptionResponse(raw: string): PhotoDescription {
  const description = matchLine(raw, 'Image Description') ?? raw.trim();
  const extractedText = matchLine(raw, 'Extracted Text');
  const keyElementsLine = matchLine(raw, 'Key Elements');
  const keyElements = keyElementsLine
    ? keyElementsLine.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  return {
    description,
    extractedText: extractedText && extractedText.toLowerCase() !== 'none' ? extractedText : undefined,
    keyElements,
  };
}

function matchLine(raw: string, label: string): string | undefined {
  const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'mi');
  const m = raw.match(re);
  return m?.[1]?.trim();
}

/**
 * Persist a description to the KnowledgeBase. The `sourceId` (typically
 * SHA256 of the resized image bytes) makes re-processing the same photo
 * idempotent via the (source, source_id) UNIQUE constraint — the old
 * `mnemon remember --photo` had no such guard.
 */
export async function rememberInMnemon(
  description: PhotoDescription,
  source: string,
  sourceId?: string,
): Promise<void> {
  const text = [
    description.description,
    description.extractedText ? `Text: ${description.extractedText}` : null,
    description.keyElements?.length ? `Elements: ${description.keyElements.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  const kb = await getKnowledgeBase();
  await kb.store({
    text,
    source,
    source_id: sourceId,
    category: 'photo',
    tags: ['pocketclaw', 'kind:photo', `src:${source}`],
    entities: description.keyElements ?? [],
    metadata: {
      description: description.description,
      extracted_text: description.extractedText ?? null,
      key_elements: description.keyElements ?? null,
    },
  });
}

/** SHA256 of the file at `filePath`, hex-encoded. */
async function sha256OfFile(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Full pipeline. The cache file is ALWAYS deleted, even on failure.
 */
export interface ProcessPhotoResult {
  ok: boolean;
  description?: PhotoDescription;
  error?: string;
}

export async function processPhoto(
  cachedPhotoPath: string,
  userMessage: string,
  platform: string,
): Promise<ProcessPhotoResult> {
  // Track the resized path so we can clean it up on failure paths too.
  // Without this, a vision-describe failure leaks \`${base}.resized${ext}\`
  // forever (resizePhoto already deleted the original).
  let resizedPath: string | undefined;
  try {
    const validation = await validatePhoto(cachedPhotoPath);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }

    resizedPath = await resizePhoto(cachedPhotoPath);
    const description = await generateDescription(resizedPath, userMessage, platform);
    const sourceId = await sha256OfFile(resizedPath);
    await rememberInMnemon(description, platform, sourceId);

    return { ok: true, description };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    // Original is usually already gone (resizePhoto unlinks it on success),
    // but if validate threw or resize failed before its unlink, this is the
    // safety net. Both ignore-on-miss.
    await fs.unlink(cachedPhotoPath).catch(() => undefined);
    if (resizedPath && resizedPath !== cachedPhotoPath) {
      await fs.unlink(resizedPath).catch(() => undefined);
    }
  }
}
