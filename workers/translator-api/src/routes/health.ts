import type { HealthResponse } from '@turntranslate/shared';
import type { ApiConfig } from '../env';
import { jsonResponse, methodNotAllowed, toErrorResponse } from '../errors';
import { activeTranslationEngine } from '../services/translationService';

export function handleHealth(
  request: Request,
  config: ApiConfig,
  corsHeaders: HeadersInit,
): Response {
  if (request.method !== 'GET') {
    return toErrorResponse(methodNotAllowed(request.method), corsHeaders);
  }
  const body: HealthResponse = {
    status: 'ok',
    service: 'turntranslate-api',
    // Lets an operator verify from a browser that DeepL is actually active.
    translationEngine: activeTranslationEngine(config),
  };
  return jsonResponse(body, 200, corsHeaders);
}
