/**
 * Typed HTTP client for the translator-api Worker. Talks only to the
 * configured base URL, carries no credentials (the Worker holds the AI
 * binding), validates every response against the shared guards, and rejects
 * stale replies whose requestId does not match the request.
 */

import type {
  ConversationDirection,
  InterpretSuccessResponse,
  LanguageCode,
  TranslateTextRequest,
} from '@turntranslate/shared';
import { API_PATHS, isApiErrorResponse, isInterpretSuccessResponse } from '@turntranslate/shared';
import {
  RequestCancelledError,
  RequestTimeoutError,
  abortableFetch,
} from '../utils/abortableRequest';
import { TranslationClientError } from './apiErrors';

export interface InterpretParams {
  wav: Blob;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  direction: ConversationDirection;
  requestId: string;
  signal?: AbortSignal;
}

export interface TranslateTextParams {
  text: string;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  direction: ConversationDirection;
  requestId: string;
  signal?: AbortSignal;
}

export interface TranslationClient {
  interpretUtterance(params: InterpretParams): Promise<InterpretSuccessResponse>;
  translateText(params: TranslateTextParams): Promise<InterpretSuccessResponse>;
}

export interface TranslationClientOptions {
  baseUrl: string;
  timeoutMs: number;
}

export function createTranslationClient(options: TranslationClientOptions): TranslationClient {
  const interpretUrl = `${options.baseUrl}${API_PATHS.interpret}`;
  const translateTextUrl = `${options.baseUrl}${API_PATHS.translateText}`;

  return {
    async interpretUtterance(params) {
      const form = new FormData();
      form.append('audio', params.wav, 'utterance.wav');
      form.append('sourceLanguage', params.sourceLanguage);
      form.append('targetLanguage', params.targetLanguage);
      form.append('direction', params.direction);
      form.append('requestId', params.requestId);

      const response = await performFetch(interpretUrl, { method: 'POST', body: form }, params);
      return parseInterpretResponse(response, params.requestId);
    },

    async translateText(params) {
      const body: TranslateTextRequest = {
        text: params.text,
        sourceLanguage: params.sourceLanguage,
        targetLanguage: params.targetLanguage,
        direction: params.direction,
        requestId: params.requestId,
      };
      const response = await performFetch(
        translateTextUrl,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        params,
      );
      return parseInterpretResponse(response, params.requestId);
    },
  };

  async function performFetch(
    url: string,
    init: RequestInit,
    params: { signal?: AbortSignal },
  ): Promise<Response> {
    try {
      return await abortableFetch(url, init, {
        timeoutMs: options.timeoutMs,
        signal: params.signal,
      });
    } catch (error) {
      if (error instanceof RequestTimeoutError) throw TranslationClientError.timeout();
      if (error instanceof RequestCancelledError) throw TranslationClientError.cancelled();
      throw TranslationClientError.network();
    }
  }
}

async function parseInterpretResponse(
  response: Response,
  expectedRequestId: string,
): Promise<InterpretSuccessResponse> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw TranslationClientError.malformed();
  }

  if (!response.ok) {
    if (isApiErrorResponse(payload)) {
      throw TranslationClientError.fromApiPayload(payload.error);
    }
    throw TranslationClientError.malformed();
  }

  if (!isInterpretSuccessResponse(payload)) {
    throw TranslationClientError.malformed();
  }
  if (payload.requestId !== expectedRequestId) {
    // A reply for a different request must never be shown to the user.
    throw TranslationClientError.stale();
  }
  return payload;
}
