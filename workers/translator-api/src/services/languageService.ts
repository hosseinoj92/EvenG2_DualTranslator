/**
 * Language validation for the Worker, backed by the shared registry so the
 * backend can never accept a language the frontend does not offer (or vice
 * versa). Both configured models accept ISO 639-1 codes for every registry
 * entry — see the README "Adding languages" section for the verification
 * procedure required before extending the registry.
 */

import type { LanguageDefinition } from '@turntranslate/shared';
import { validateLanguagePair } from '@turntranslate/shared';
import { ApiError } from '../errors';

export interface ValidatedLanguagePair {
  source: LanguageDefinition;
  target: LanguageDefinition;
}

export function validateLanguagePairOrThrow(
  source: unknown,
  target: unknown,
): ValidatedLanguagePair {
  const result = validateLanguagePair(source, target);
  if (!result.ok) {
    throw new ApiError(result.reason, 400, result.detail);
  }
  return { source: result.source, target: result.target };
}
