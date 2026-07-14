/**
 * Runtime validation for API payloads. The Worker validates inbound requests
 * with these guards; the frontend validates responses before trusting them.
 */

import type { ApiErrorResponse, InterpretSuccessResponse, TranslateTextRequest } from './api';
import { isConversationDirection } from './api';
import { isSupportedLanguageCode } from './languages';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isInterpretSuccessResponse(value: unknown): value is InterpretSuccessResponse {
  if (!isRecord(value)) return false;
  return (
    typeof value.requestId === 'string' &&
    isConversationDirection(value.direction) &&
    isSupportedLanguageCode(value.sourceLanguage) &&
    isSupportedLanguageCode(value.targetLanguage) &&
    typeof value.transcript === 'string' &&
    typeof value.translation === 'string' &&
    typeof value.processingTimeMs === 'number' &&
    Number.isFinite(value.processingTimeMs) &&
    isStringArray(value.warnings)
  );
}

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (!isRecord(value)) return false;
  const error = value.error;
  if (!isRecord(error)) return false;
  return (
    typeof error.code === 'string' &&
    typeof error.message === 'string' &&
    typeof error.retryable === 'boolean'
  );
}

export function isTranslateTextRequest(value: unknown): value is TranslateTextRequest {
  if (!isRecord(value)) return false;
  return (
    typeof value.text === 'string' &&
    isSupportedLanguageCode(value.sourceLanguage) &&
    isSupportedLanguageCode(value.targetLanguage) &&
    isConversationDirection(value.direction) &&
    typeof value.requestId === 'string'
  );
}
