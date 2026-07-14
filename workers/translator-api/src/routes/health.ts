import type { HealthResponse } from '@turntranslate/shared';
import { jsonResponse, methodNotAllowed, toErrorResponse } from '../errors';

export function handleHealth(request: Request, corsHeaders: HeadersInit): Response {
  if (request.method !== 'GET') {
    return toErrorResponse(methodNotAllowed(request.method), corsHeaders);
  }
  const body: HealthResponse = { status: 'ok', service: 'turntranslate-api' };
  return jsonResponse(body, 200, corsHeaders);
}
