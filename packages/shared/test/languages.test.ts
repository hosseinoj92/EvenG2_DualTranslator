import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MY_LANGUAGE,
  DEFAULT_OTHER_LANGUAGE,
  LANGUAGE_CODES,
  SUPPORTED_LANGUAGES,
  findLanguage,
  getLanguage,
  isSupportedLanguageCode,
  validateLanguagePair,
} from '../src/index';

describe('language registry', () => {
  it('contains the eight launch languages', () => {
    expect(LANGUAGE_CODES).toEqual(['en', 'es', 'de', 'fr', 'it', 'pt', 'nl', 'tr']);
    expect(SUPPORTED_LANGUAGES).toHaveLength(8);
  });

  it('defaults to English speaker with Spanish counterpart', () => {
    expect(DEFAULT_MY_LANGUAGE).toBe('en');
    expect(DEFAULT_OTHER_LANGUAGE).toBe('es');
  });

  it('looks up languages by code', () => {
    expect(getLanguage('es')).toEqual({ code: 'es', name: 'Spanish', shortLabel: 'ES' });
    expect(findLanguage('fr')?.name).toBe('French');
    expect(findLanguage('xx')).toBeUndefined();
  });

  it('every entry has a consistent shortLabel', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(language.shortLabel).toBe(language.code.toUpperCase());
      expect(language.name.length).toBeGreaterThan(2);
    }
  });

  it('validates membership defensively', () => {
    expect(isSupportedLanguageCode('en')).toBe(true);
    expect(isSupportedLanguageCode('EN')).toBe(false);
    expect(isSupportedLanguageCode('')).toBe(false);
    expect(isSupportedLanguageCode(42)).toBe(false);
    expect(isSupportedLanguageCode(null)).toBe(false);
  });
});

describe('validateLanguagePair', () => {
  it('accepts a valid distinct pair', () => {
    const result = validateLanguagePair('es', 'en');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source.code).toBe('es');
      expect(result.target.code).toBe('en');
    }
  });

  it('rejects unknown source and target codes', () => {
    expect(validateLanguagePair('xx', 'en')).toMatchObject({
      ok: false,
      reason: 'UNSUPPORTED_LANGUAGE',
    });
    expect(validateLanguagePair('en', 'zz')).toMatchObject({
      ok: false,
      reason: 'UNSUPPORTED_LANGUAGE',
    });
  });

  it('rejects identical source and target', () => {
    expect(validateLanguagePair('en', 'en')).toMatchObject({
      ok: false,
      reason: 'SAME_LANGUAGE_PAIR',
    });
  });

  it('never throws on hostile input', () => {
    expect(validateLanguagePair(undefined, { evil: true })).toMatchObject({ ok: false });
    expect(validateLanguagePair(['en'], 'es')).toMatchObject({ ok: false });
  });
});
