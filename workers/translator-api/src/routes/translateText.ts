/**
 * POST /api/v1/translate-text — manual typed translation from the companion
 * UI. Reuses the same translation service and response contract as the audio
 * pipeline; the typed input is echoed back as `transcript`.
 */

import type { InterpretSuccessResponse } from '@turntranslate/shared';
import { jsonResponse, methodNotAllowed, toErrorResponse } from '../errors';
import { parseTranslateTextRequest } from '../validation';
import type { ApiConfig } from '../env';
import type { TranslationService } from '../services/translationService';

export interface TranslateTextDependencies {
  config: ApiConfig;
  translation: TranslationService;
}

export async function handleTranslateText(
  request: Request,
  deps: TranslateTextDependencies,
  corsHeaders: HeadersInit,
): Promise<Response> {
  if (request.method !== 'POST') {
    return toErrorResponse(methodNotAllowed(request.method), corsHeaders);
  }

  const startedAt = Date.now();
  try {
    const input = await parseTranslateTextRequest(request, deps.config);
    const translation = await deps.translation.translate(
      input.text,
      input.sourceLanguage,
      input.targetLanguage,
    );

    const body: InterpretSuccessResponse = {
      requestId: input.requestId,
      direction: input.direction,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      transcript: input.text,
      translation,
      processingTimeMs: Date.now() - startedAt,
      warnings: [],
    };
    return jsonResponse(body, 200, corsHeaders);
  } catch (error) {
    return toErrorResponse(error, corsHeaders);
  }
}
