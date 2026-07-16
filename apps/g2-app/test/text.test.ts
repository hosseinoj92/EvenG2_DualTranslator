import { describe, expect, it } from 'vitest';
import {
  normalizeWhitespace,
  paginateText,
  stripMarkup,
  toDisplayBlock,
  toDisplayText,
  truncateWithEllipsis,
} from '../src/utils/text';

describe('normalizeWhitespace', () => {
  it('collapses runs of spaces, tabs and newlines', () => {
    expect(normalizeWhitespace('  hello \n\t world  ')).toBe('hello world');
    expect(normalizeWhitespace('')).toBe('');
  });
});

describe('stripMarkup', () => {
  it('removes HTML tags', () => {
    expect(normalizeWhitespace(stripMarkup('<b>Hola</b> <script>x()</script>mundo'))).toBe(
      'Hola x() mundo',
    );
  });

  it('removes common markdown decorations', () => {
    expect(normalizeWhitespace(stripMarkup('**bold** _it_ `code` # title'))).toBe(
      'bold it code title',
    );
  });

  it('keeps link text, drops the URL', () => {
    expect(normalizeWhitespace(stripMarkup('[station](https://example.com)'))).toBe('station');
  });
});

describe('truncateWithEllipsis', () => {
  it('returns short text unchanged', () => {
    expect(truncateWithEllipsis('hola', 10)).toBe('hola');
  });

  it('cuts at a word boundary and appends an ellipsis', () => {
    const result = truncateWithEllipsis('the quick brown fox jumps over the lazy dog', 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith('…')).toBe(true);
    expect(result).toBe('the quick brown…');
  });

  it('cuts mid-word when the only word is longer than the budget', () => {
    const result = truncateWithEllipsis('Donaudampfschifffahrtsgesellschaft', 12);
    expect(result.length).toBeLessThanOrEqual(12);
    expect(result.endsWith('…')).toBe(true);
  });

  it('handles degenerate budgets', () => {
    expect(truncateWithEllipsis('abc', 1)).toBe('…');
    expect(truncateWithEllipsis('', 1)).toBe('');
  });
});

describe('toDisplayText', () => {
  it('sanitizes and truncates in one pass', () => {
    const input = '  <em>¿Dónde\nestá   la estación?</em>  ';
    expect(toDisplayText(input, 100)).toBe('¿Dónde está la estación?');
  });
});

describe('toDisplayBlock', () => {
  it('preserves intentional line breaks while normalizing each line', () => {
    const input = '¿Dónde   está?\n\n→  Where   is it?';
    expect(toDisplayBlock(input, 100)).toBe('¿Dónde está?\n\n→ Where is it?');
  });

  it('collapses runs of blank lines and trims blank edges', () => {
    expect(toDisplayBlock('\n\na\n\n\n\nb\n\n', 100)).toBe('a\n\nb');
  });

  it('strips markup per line and keeps Unicode intact', () => {
    expect(toDisplayBlock('<b>Größe</b>\n\n**Ça va**', 100)).toBe('Größe\n\nÇa va');
  });

  it('truncates with an ellipsis when over budget', () => {
    const result = toDisplayBlock('first line words\n\nsecond line words', 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('paginateText', () => {
  it('returns short text as a single page', () => {
    expect(paginateText('hola mundo', 50)).toEqual(['hola mundo']);
    expect(paginateText('', 50)).toEqual(['']);
  });

  it('splits at word boundaries and never loses content', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
    const pages = paginateText(words.join(' '), 60);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(60);
    }
    // Reassembling the pages yields exactly the original words, none cut.
    expect(pages.join(' ').split(/\s+/)).toEqual(words);
  });

  it('cuts an overlong single word mid-word rather than overflowing', () => {
    const pages = paginateText('x'.repeat(25), 10);
    expect(pages).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('prefers line breaks as split points', () => {
    const pages = paginateText('first part\nsecond part', 15);
    expect(pages).toEqual(['first part', 'second part']);
  });
});
