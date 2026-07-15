/**
 * Text hygiene for the glasses display and the companion UI. Model output and
 * transcripts are untrusted: they may contain markup, odd whitespace or be far
 * too long for a 576×288 panel.
 */

const ELLIPSIS = '…';

/** Collapses all runs of whitespace (incl. newlines) into single spaces. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Removes HTML tags and the most common Markdown decorations so raw markup
 * never reaches the glasses. This is display sanitation, not a security
 * boundary — the phone UI additionally renders via textContent only.
 */
export function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/**
 * Truncates to maxChars, preferring to cut at a word boundary (space or line
 * break), and appends an ellipsis when anything was removed.
 */
export function truncateWithEllipsis(text: string, maxChars: number): string {
  if (maxChars <= 1) return text.length > 0 ? ELLIPSIS : '';
  if (text.length <= maxChars) return text;

  const budget = maxChars - ELLIPSIS.length;
  const hardCut = text.slice(0, budget);
  const lastSpace = Math.max(hardCut.lastIndexOf(' '), hardCut.lastIndexOf('\n'));
  // Only respect the word boundary when it does not sacrifice most of the
  // budget (very long single words are cut mid-word instead).
  const cut = lastSpace > budget * 0.5 ? hardCut.slice(0, lastSpace) : hardCut;
  return cut.trimEnd() + ELLIPSIS;
}

/** Full pipeline used before any text goes to a glasses container. */
export function toDisplayText(text: string, maxChars: number): string {
  return truncateWithEllipsis(normalizeWhitespace(stripMarkup(text)), maxChars);
}

/**
 * Multiline variant of `toDisplayText` for composed glasses bodies (e.g.
 * transcript + translation). Each line is sanitized and whitespace-normalized
 * on its own so intentional line breaks survive; runs of blank lines collapse
 * to a single blank line.
 */
export function toDisplayBlock(text: string, maxChars: number): string {
  const lines = stripMarkup(text)
    .split('\n')
    .map((line) => normalizeWhitespace(line));
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line === '' && collapsed[collapsed.length - 1] === '') continue;
    collapsed.push(line);
  }
  while (collapsed[0] === '') collapsed.shift();
  while (collapsed[collapsed.length - 1] === '') collapsed.pop();
  return truncateWithEllipsis(collapsed.join('\n'), maxChars);
}
