/**
 * Machine translation behind a provider-agnostic interface. The default
 * implementation uses Workers AI `@cf/meta/m2m100-1.2b`, a dedicated
 * translation model — deliberately not a chat LLM, so the output is the
 * translation and nothing else (no explanations, no added text).
 */

import type { LanguageCode } from '@turntranslate/shared';
import { ApiError } from '../errors';
import type { ApiConfig } from '../env';

export interface TranslationService {
  translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string>;
}

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
