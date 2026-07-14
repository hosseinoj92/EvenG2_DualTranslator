/**
 * Typed client-side errors. Every failure mode of the translation client maps
 * to one of these, each carrying a short user-facing message (no stack traces,
 * no URLs) and a retryability flag the state machine can act on.
 */

import type { ApiErrorPayload } from '@turntranslate/shared';

export type ClientErrorCode =
  | 'NETWORK_ERROR'
  | 'BACKEND_OFFLINE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'MALFORMED_RESPONSE'
  | 'STALE_RESPONSE'
  | (string & {});

export class TranslationClientError extends Error {
  readonly code: ClientErrorCode;
  readonly retryable: boolean;
  /** Short message safe to show to the user. */
  readonly userMessage: string;

  constructor(code: ClientErrorCode, userMessage: string, retryable: boolean) {
    super(`${code}: ${userMessage}`);
    this.name = 'TranslationClientError';
    this.code = code;
    this.retryable = retryable;
    this.userMessage = userMessage;
  }

  static fromApiPayload(payload: ApiErrorPayload): TranslationClientError {
    return new TranslationClientError(
      payload.code,
      friendlyBackendMessage(payload),
      payload.retryable,
    );
  }

  static network(): TranslationClientError {
    return new TranslationClientError('NETWORK_ERROR', 'Translation service unavailable', true);
  }

  static timeout(): TranslationClientError {
    return new TranslationClientError('TIMEOUT', 'Translation took too long', true);
  }

  static cancelled(): TranslationClientError {
    return new TranslationClientError('CANCELLED', 'Request cancelled', false);
  }

  static malformed(): TranslationClientError {
    return new TranslationClientError(
      'MALFORMED_RESPONSE',
      'Unexpected reply from the translation service',
      true,
    );
  }

  static stale(): TranslationClientError {
    return new TranslationClientError('STALE_RESPONSE', 'Outdated reply ignored', false);
  }
}

/** Maps backend error codes to phrasing suitable for the glasses display. */
function friendlyBackendMessage(payload: ApiErrorPayload): string {
  switch (payload.code) {
    case 'NO_SPEECH_DETECTED':
      return 'No speech detected — try again';
    case 'AUDIO_TOO_LONG':
      return 'That was too long — speak in shorter sentences';
    case 'AUDIO_TOO_LARGE':
      return 'Recording too large — try a shorter sentence';
    case 'UNSUPPORTED_LANGUAGE':
      return 'Language not supported';
    case 'SAME_LANGUAGE_PAIR':
      return 'Both languages are the same';
    case 'TRANSCRIPTION_FAILED':
      return 'Could not understand the audio';
    case 'TRANSLATION_FAILED':
      return 'Translation failed — try again';
    default:
      return 'Translation service error';
  }
}
