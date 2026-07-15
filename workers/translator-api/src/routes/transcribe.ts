/**
 * POST /api/v1/transcribe — final-utterance transcription only: WAV in,
 * transcript out. Deliberately never touches the translation service; the
 * client shows the completed transcript immediately and requests the
 * translation separately via /api/v1/translate-text.
 */

import type { TranscriptionSuccessResponse } from '@turntranslate/shared';
import { jsonResponse, methodNotAllowed, toErrorResponse } from '../errors';
import { parseTranscribeRequest } from '../validation';
import type { ApiConfig } from '../env';
import type { TranscriptionService } from '../services/transcriptionService';

export interface TranscribeDependencies {
  config: ApiConfig;
  transcription: TranscriptionService;
}

export async function handleTranscribe(
  request: Request,
  deps: TranscribeDependencies,
  corsHeaders: HeadersInit,
): Promise<Response> {
  if (request.method !== 'POST') {
    return toErrorResponse(methodNotAllowed(request.method), corsHeaders);
  }

  const startedAt = Date.now();
  try {
    const input = await parseTranscribeRequest(request, deps.config);
    const transcript = await deps.transcription.transcribe(input.audio, input.sourceLanguage);

    const body: TranscriptionSuccessResponse = {
      requestId: input.requestId,
      sourceLanguage: input.sourceLanguage,
      transcript,
      processingTimeMs: Date.now() - startedAt,
    };
    return jsonResponse(body, 200, corsHeaders);
  } catch (error) {
    return toErrorResponse(error, corsHeaders);
  }
}
