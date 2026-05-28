/**
 * Clawd — Shared ingestion types
 */

/**
 * A `Fact` is the canonical unit fed into mnemon. Each ingester emits an
 * array of facts; the scheduler walks them and calls `mnemon remember` for
 * each.
 */
export interface Fact {
  /** Cleaned, deduped natural-language sentence. */
  text: string;
  /** Where this came from — `gmail`, `outlook-calendar`, `icloud-contacts`, etc. */
  source: string;
  /** Optional source-id (gmail message id, calendar event id, contact uid). */
  sourceId?: string;
  /** Stable URL or pointer that lets the agent re-fetch if needed. */
  link?: string;
  /** Original timestamp on the underlying record. */
  occurredAt?: Date;
  /** Bag of additional metadata that mnemon can treat as opaque. */
  meta?: Record<string, string | number | boolean>;
}

export interface IngestResult {
  /** Logical name of the source — e.g., `gmail`, `outlook-mail`. */
  source: string;
  /** How many facts produced. */
  factsCount: number;
  /** Any non-fatal errors collected during the run. */
  errors: string[];
  /** Wall-clock duration in ms. */
  durationMs: number;
}

export interface CloudIngester {
  /** Stable name used in scheduler output and audit log. */
  readonly source: string;
  /**
   * Pull data from the cloud source and return facts. MUST not throw — wrap
   * partial failures in `IngestResult.errors`. Throwing is reserved for
   * configuration problems (missing creds, etc.).
   */
  fetch(since: Date): Promise<{ facts: Fact[]; errors: string[] }>;
}

/** Strip HTML tags from a string — defensive measure against prompt injection. */
export function stripHtml(input: string): string {
  return input
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
