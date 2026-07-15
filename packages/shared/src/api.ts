/**
 * Wire contracts shared by the G2 frontend and the translator-api Worker.
 * Both sides import these types; neither is allowed to define its own copy.
 */

import type { LanguageCode } from './languages';

export const CONVERSATION_DIRECTIONS = ['them-to-me', 'me-to-them'] as const;

/**
 * `them-to-me`: the other person spoke; translate their language into mine.
 * `me-to-them`: I spoke; translate my language into theirs so I can read it aloud.
 */
export type ConversationDirection = (typeof CONVERSATION_DIRECTIONS)[number];

export function isConversationDirection(value: unknown): value is ConversationDirection {
  return (
    typeof value === 'string' && (CONVERSATION_DIRECTIONS as readonly string[]).includes(value)
  );
}

/** Route table, shared so the client can never drift from the Worker. */
export const API_PATHS = {
  health: '/health',
  interpret: '/api/v1/interpret',
  transcribe: '/api/v1/transcribe',
  translateText: '/api/v1/translate-text',
} as const;

/** Constraints enforced by the Worker and respected by the client. */
export const API_LIMITS = {
  /** Hard cap on the uploaded WAV payload. 30 s of 16 kHz mono s16le is ~940 KB. */
  maxAudioBytes: 4 * 1024 * 1024,
  /**
   * Longest utterance the service will transcribe. Slightly above the
   * frontend's 30 s recording cap so a maximum-length utterance (plus
   * pre-roll) is never rejected.
   */
  maxUtteranceMs: 32_000,
  /** Longest accepted manual text input. */
  maxTextLength: 1_000,
  /** requestId must be a short opaque token (UUIDs are 36 chars). */
  maxRequestIdLength: 64,
} as const;

export interface InterpretSuccessResponse {
  requestId: string;
  direction: ConversationDirection;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  /** What was said, in the source language (or the typed text for manual input). */
  transcript: string;
  /** The translation, in the target language. */
  translation: string;
  processingTimeMs: number;
  warnings: string[];
}

/**
 * Body of `POST /api/v1/transcribe` (multipart/form-data): `audio` (WAV file),
 * `sourceLanguage`, `requestId`. Transcription only — no translation happens
 * on this endpoint; the client translates the returned transcript separately
 * via `POST /api/v1/translate-text`.
 */
export interface TranscriptionSuccessResponse {
  requestId: string;
  sourceLanguage: LanguageCode;
  /** The final transcript of the completed utterance, in the source language. */
  transcript: string;
  processingTimeMs: number;
}

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'METHOD_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_LANGUAGE'
  | 'SAME_LANGUAGE_PAIR'
  | 'AUDIO_TOO_LARGE'
  | 'AUDIO_TOO_LONG'
  | 'INVALID_AUDIO'
  | 'NO_SPEECH_DETECTED'
  | 'TRANSCRIPTION_FAILED'
  | 'TRANSLATION_FAILED'
  | 'INTERNAL_ERROR';

export interface ApiErrorPayload {
  code: ApiErrorCode | string;
  message: string;
  /** True when the same request may succeed if retried (transient upstream issues). */
  retryable: boolean;
}

export interface ApiErrorResponse {
  error: ApiErrorPayload;
}

/** Body of `POST /api/v1/translate-text`. */
export interface TranslateTextRequest {
  text: string;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  direction: ConversationDirection;
  requestId: string;
}

export interface HealthResponse {
  status: 'ok';
  service: 'turntranslate-api';
}
