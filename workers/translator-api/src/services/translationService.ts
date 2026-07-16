/**
 * Machine translation behind a provider-agnostic interface.
 *
 * Primary engine: the DeepL REST API (free tier: 500,000 characters/month),
 * selected whenever a DEEPL_API_KEY secret is configured. Without a key the
 * service falls back to Workers AI `@cf/meta/m2m100-1.2b` so development
 * setups keep working — the active engine is reported by /api/v1/health.
 */

import type { LanguageCode } from '@turntranslate/shared';
import { ApiError } from '../errors';
import type { ApiConfig } from '../env';

export interface TranslationService {
  translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string>;
}

export type TranslationEngine = 'deepl' | 'workers-ai';

export function activeTranslationEngine(config: ApiConfig): TranslationEngine {
  return config.deepl.apiKey.length > 0 ? 'deepl' : 'workers-ai';
}

/** Picks DeepL when a key is configured, Workers AI m2m100 otherwise. */
export function createTranslationService(ai: Ai, config: ApiConfig): TranslationService {
  if (activeTranslationEngine(config) === 'deepl') {
    return createDeepLTranslationService(config);
  }
  console.warn('DEEPL_API_KEY is not set — falling back to Workers AI m2m100 translation');
  return createWorkersAiTranslationService(ai, config);
}

// ----- DeepL ----------------------------------------------------------------

/**
 * DeepL source languages take the plain ISO 639-1 code; target languages for
 * English and Portuguese require a regional variant (plain EN/PT targets are
 * deprecated). EN-US and PT-PT are this app's chosen variants — adjust here
 * if American English or Brazilian Portuguese is not what you want.
 */
export const DEEPL_SOURCE_LANG: Record<LanguageCode, string> = {
  en: 'EN',
  es: 'ES',
  de: 'DE',
  fr: 'FR',
  it: 'IT',
  pt: 'PT',
  nl: 'NL',
  tr: 'TR',
};

export const DEEPL_TARGET_LANG: Record<LanguageCode, string> = {
  en: 'EN-US',
  es: 'ES',
  de: 'DE',
  fr: 'FR',
  it: 'IT',
  pt: 'PT-PT',
  nl: 'NL',
  tr: 'TR',
};

export function createDeepLTranslationService(config: ApiConfig): TranslationService {
  return {
    async translate(text, source, target) {
      let response: Response;
      try {
        response = await fetch(config.deepl.endpoint, {
          method: 'POST',
          headers: {
            authorization: `DeepL-Auth-Key ${config.deepl.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            text: [text],
            source_lang: DEEPL_SOURCE_LANG[source],
            target_lang: DEEPL_TARGET_LANG[target],
          }),
        });
      } catch (error) {
        console.error('deepl request failed:', describeUpstreamError(error));
        throw new ApiError('TRANSLATION_FAILED', 502, 'Translation failed', true);
      }

      if (!response.ok) {
        throw deeplHttpError(response.status);
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new ApiError('TRANSLATION_FAILED', 502, 'Translation returned no text', true);
      }

      const translation = normalizeDeepLTranslation(raw);
      if (!translation) {
        throw new ApiError('TRANSLATION_FAILED', 502, 'Translation returned no text', true);
      }
      return translation;
    },
  };
}

/**
 * Maps DeepL HTTP failures to the client contract. Status meanings are from
 * the DeepL API reference; the two cases users can actually act on (quota
 * exhausted, rate limited) get distinct messages.
 */
export function deeplHttpError(status: number): ApiError {
  if (status === 456) {
    // Free-tier character quota (500k/month) used up: retrying won't help.
    console.error('deepl translation failed: monthly character quota exceeded (456)');
    return new ApiError('TRANSLATION_FAILED', 502, 'Monthly translation quota exhausted', false);
  }
  if (status === 429) {
    console.error('deepl translation failed: rate limited (429)');
    return new ApiError('TRANSLATION_FAILED', 502, 'Translation service is busy — try again', true);
  }
  if (status === 401 || status === 403) {
    // Misconfigured key: an operator problem, never solvable by retrying.
    console.error(`deepl translation failed: authentication rejected (${status})`);
    return new ApiError('TRANSLATION_FAILED', 502, 'Translation failed', false);
  }
  console.error(`deepl translation failed: HTTP ${status}`);
  return new ApiError('TRANSLATION_FAILED', 502, 'Translation failed', true);
}

/** Documented shape: `{ translations: [{ text: string, ... }] }`. */
export function normalizeDeepLTranslation(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return '';
  const translations = (raw as Record<string, unknown>).translations;
  if (!Array.isArray(translations) || translations.length === 0) return '';
  const first = translations[0] as Record<string, unknown> | null;
  if (typeof first !== 'object' || first === null) return '';
  return typeof first.text === 'string' ? first.text.trim() : '';
}

// ----- Workers AI fallback ---------------------------------------------------

export function createWorkersAiTranslationService(ai: Ai, config: ApiConfig): TranslationService {
  return {
    async translate(text, source, target) {
      let raw: unknown;
      try {
        raw = await ai.run(config.models.translation, {
          text,
          source_lang: source,
          target_lang: target,
        });
      } catch (error) {
        console.error('workers-ai translation failed:', describeUpstreamError(error));
        throw new ApiError('TRANSLATION_FAILED', 502, 'Translation failed', true);
      }

      const translation = normalizeTranslation(raw);
      if (!translation) {
        throw new ApiError('TRANSLATION_FAILED', 502, 'Translation returned no text', true);
      }
      return translation;
    },
  };
}

/** Documented output is `{ translated_text: string }`; tolerate close variants. */
export function normalizeTranslation(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw !== 'object' || raw === null) return '';
  const record = raw as Record<string, unknown>;
  if (typeof record.translated_text === 'string') return record.translated_text.trim();
  if (typeof record.translation === 'string') return record.translation.trim();
  return '';
}

function describeUpstreamError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
