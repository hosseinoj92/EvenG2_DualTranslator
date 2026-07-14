/**
 * Typed error model for the Worker. Every failure path funnels through
 * `ApiError` so responses always match the shared `ApiErrorResponse` contract
 * and never leak stack traces or upstream internals to clients.
 */

import type { ApiErrorCode, ApiErrorResponse } from '@turntranslate/shared';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: ApiErrorCode, status: number, message: string, retryable = false) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export const badRequest = (message: string): ApiError =>
  new ApiError('INVALID_REQUEST', 400, message);

export const methodNotAllowed = (method: string): ApiError =>
  new ApiError('METHOD_NOT_ALLOWED', 405, `Method ${method} is not allowed on this route`);

export const notFound = (): ApiError => new ApiError('NOT_FOUND', 404, 'Route not found');

export function toErrorResponse(error: unknown, extraHeaders: HeadersInit = {}): Response {
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError('INTERNAL_ERROR', 500, 'Unexpected server error', true);

  const body: ApiErrorResponse = {
    error: {
      code: apiError.code,
      message: apiError.message,
      retryable: apiError.retryable,
    },
  };

  return new Response(JSON.stringify(body), {
    status: apiError.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...securityHeaders(),
      ...normalizeHeaders(extraHeaders),
    },
  });
}

export function jsonResponse(
  payload: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...securityHeaders(),
      ...normalizeHeaders(extraHeaders),
    },
  });
}

/** Conservative headers for a JSON-only API. */
export function securityHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  };
}

function normalizeHeaders(init: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(init).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
