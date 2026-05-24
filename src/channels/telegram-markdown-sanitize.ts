/**
 * Sanitize outbound text for Telegram's legacy `Markdown` parse mode.
 *
 * WORKAROUND: The @chat-adapter/telegram adapter hardcodes parse_mode=Markdown
 * (legacy) but its converter emits CommonMark. Messages with `**bold**`, odd
 * delimiter counts, or malformed links are rejected by Telegram and dropped
 * after retries. Remove this once upstream ships real mode-aware conversion
 * (vercel/chat PR #367 adds the knob; a follow-up is needed for the converter).
 */

const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const PLACEHOLDER_PREFIX = '\x00CODE';
const PLACEHOLDER_SUFFIX = '\x00';

export function sanitizeTelegramLegacyMarkdown(input: string): string {
  if (!input) return input;

  const codeSegments: string[] = [];
  let text = input.replace(CODE_PATTERN, (m) => {
    codeSegments.push(m);
    return `${PLACEHOLDER_PREFIX}${codeSegments.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // The adapter re-parses and re-stringifies markdown before sending, which
  // rewrites `- item` list bullets into `* item` — injecting unbalanced
  // asterisks that Telegram's legacy Markdown parser then rejects. Replace
  // list bullets with a plain Unicode bullet so the adapter treats the line
  // as prose.
  text = text.replace(/^(\s*)[-+]\s+/gm, '$1• ');

  // Flatten Markdown horizontal rules (bare --- / *** / ___ lines) to a
  // plain Unicode divider. The parser doesn't understand HR syntax and the
  // `*` / `_` characters would otherwise unbalance the delimiter counts below.
  text = text.replace(/^[ \t]*[-_*]{3,}[ \t]*$/gm, '⎯⎯⎯');

  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
  text = text.replace(/__([^_\n]+?)__/g, '_$1_');

  // If `*` count is odd, the legacy Markdown parser rejects the whole
  // message. Same for `_`. Previous behaviour was to STRIP all of the
  // offending delimiter — but that silently mangles content like
  // `$variable_name` or `5*x` adjacent to legitimate emphasis. Escape
  // instead: `\*` / `\_` are literal in legacy Markdown, so the message
  // ships verbatim and the user sees the original characters. We lose
  // emphasis on that line, but no text disappears.
  const starCount = (text.match(/\*/g) ?? []).length;
  if (starCount % 2 !== 0) {
    text = text.replace(/\*/g, '\\*');
  }
  const underCount = (text.match(/_/g) ?? []).length;
  if (underCount % 2 !== 0) {
    text = text.replace(/_/g, '\\_');
  }

  // Same logic for brackets: escape rather than delete so URLs / array
  // syntax / footnote markers survive intact when they unbalance the
  // link parser.
  const openBrackets = (text.match(/\[/g) ?? []).length;
  const closeBrackets = (text.match(/\]/g) ?? []).length;
  if (openBrackets !== closeBrackets) {
    text = text.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
  }

  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, i) => codeSegments[Number(i)],
  );
}
