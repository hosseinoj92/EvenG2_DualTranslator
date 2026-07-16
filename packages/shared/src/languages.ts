/**
 * Single source of truth for every language TurnTranslate supports.
 *
 * A language may only be added here after verifying that BOTH backend engines
 * accept it:
 *   - Transcription: `@cf/openai/whisper-large-v3-turbo` (`language` input)
 *   - Translation:   DeepL (`source_lang` / `target_lang`) — also extend the
 *     DEEPL_SOURCE_LANG / DEEPL_TARGET_LANG maps in the Worker's
 *     translationService.ts, and check the Workers AI m2m100 fallback
 *
 * The frontend selector, the Worker validation and the model calls all read
 * from this registry, so one edit propagates everywhere. See the README
 * section "Adding languages" for the verification procedure.
 */

export interface LanguageDefinition {
  /** ISO 639-1 code, also used verbatim as the model language value. */
  readonly code: LanguageCode;
  /** English display name for the companion UI. */
  readonly name: string;
  /** Two-letter label used on the G2 display, e.g. `ES → EN`. */
  readonly shortLabel: string;
}

export const LANGUAGE_CODES = ['en', 'es', 'de', 'fr', 'it', 'pt', 'nl', 'tr'] as const;

export type LanguageCode = (typeof LANGUAGE_CODES)[number];

export const SUPPORTED_LANGUAGES: readonly LanguageDefinition[] = [
  { code: 'en', name: 'English', shortLabel: 'EN' },
  { code: 'es', name: 'Spanish', shortLabel: 'ES' },
  { code: 'de', name: 'German', shortLabel: 'DE' },
  { code: 'fr', name: 'French', shortLabel: 'FR' },
  { code: 'it', name: 'Italian', shortLabel: 'IT' },
  { code: 'pt', name: 'Portuguese', shortLabel: 'PT' },
  { code: 'nl', name: 'Dutch', shortLabel: 'NL' },
  { code: 'tr', name: 'Turkish', shortLabel: 'TR' },
];

/** Default pair: the user speaks English, the other person speaks Spanish. */
export const DEFAULT_MY_LANGUAGE: LanguageCode = 'en';
export const DEFAULT_OTHER_LANGUAGE: LanguageCode = 'es';

const byCode: ReadonlyMap<string, LanguageDefinition> = new Map(
  SUPPORTED_LANGUAGES.map((language) => [language.code, language]),
);

export function isSupportedLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && byCode.has(value);
}

/** Returns the definition for a code, or `undefined` for unknown codes. */
export function findLanguage(code: string): LanguageDefinition | undefined {
  return byCode.get(code);
}

/** Returns the definition for a known code. Throws on unknown codes. */
export function getLanguage(code: LanguageCode): LanguageDefinition {
  const language = byCode.get(code);
  if (!language) {
    throw new Error(`Unsupported language code: ${code}`);
  }
  return language;
}

export type LanguagePairValidation =
  | { ok: true; source: LanguageDefinition; target: LanguageDefinition }
  | { ok: false; reason: 'UNSUPPORTED_LANGUAGE' | 'SAME_LANGUAGE_PAIR'; detail: string };

/**
 * Validates a source/target pair coming from untrusted input (form fields,
 * query params, stored settings). Never throws.
 */
export function validateLanguagePair(source: unknown, target: unknown): LanguagePairValidation {
  if (!isSupportedLanguageCode(source)) {
    return {
      ok: false,
      reason: 'UNSUPPORTED_LANGUAGE',
      detail: `sourceLanguage "${String(source)}" is not supported`,
    };
  }
  if (!isSupportedLanguageCode(target)) {
    return {
      ok: false,
      reason: 'UNSUPPORTED_LANGUAGE',
      detail: `targetLanguage "${String(target)}" is not supported`,
    };
  }
  if (source === target) {
    return {
      ok: false,
      reason: 'SAME_LANGUAGE_PAIR',
      detail: `sourceLanguage and targetLanguage must differ (both "${source}")`,
    };
  }
  return { ok: true, source: getLanguage(source), target: getLanguage(target) };
}
