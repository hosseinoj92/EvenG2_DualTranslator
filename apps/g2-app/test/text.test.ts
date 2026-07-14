import { describe, expect, it } from 'vitest';
import {
  normalizeWhitespace,
  stripMarkup,
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
