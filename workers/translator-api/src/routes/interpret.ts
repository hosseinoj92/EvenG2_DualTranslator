/**
 * POST /api/v1/interpret — the speech pipeline: WAV in, transcript +
 * translation out. Orchestration only; transcription and translation are
 * injected services so tests can run without Workers AI.
 */

import type { InterpretSuccessResponse } from '@turntranslate/shared';
import { jsonResponse, methodNotAllowed, toErrorResponse } from '../errors';
import { parseInterpretRequest } from '../validation';
import type { ApiConfig } from '../env';
import type { TranscriptionService } from '../services/transcriptionService';
import type { TranslationService } from '../services/translationService';

export interface InterpretDependencies {
  config: ApiConfig;
  transcription: TranscriptionService;
  translation: TranslationService;
}

export async function handleInterpret(
  request: Request,
  deps: InterpretDependencies,
  corsHeaders: HeadersInit,
): Promise<Response> {
  if (request.method !== 'POST') {
    return toErrorResponse(methodNotAllowed(request.method), corsHeaders);
  }

  const startedAt = Date.now();
  try {
    const input = await parseInterpretRequest(request, deps.config);

    const transcript = await deps.transcription.transcribe(input.audio, input.sourceLanguage);
    const translation = await deps.translation.translate(
      transcript,
      input.sourceLanguage,
      input.targetLanguage,
    );

    const body: InterpretSuccessResponse = {
      requestId: input.requestId,
      direction: input.direction,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      transcript,
      translation,
      processingTimeMs: Date.now() - startedAt,
      warnings: input.warnings,
    };
    return jsonResponse(body, 200, corsHeaders);
  } catch (error) {
    return toErrorResponse(error, corsHeaders);
  }
}
