/**
 * Worker environment bindings and the single backend configuration module.
 * Every model name, size limit and CORS rule lives here — routes and services
 * must not hard-code any of these values.
 */

import { API_LIMITS } from '@turntranslate/shared';

export interface Env {
  /** Workers AI binding, configured as `[ai] binding = "AI"` in wrangler.toml. */
  AI: Ai;
  /** Comma-separated allowlist of CORS origins. May be empty. */
  ALLOWED_ORIGINS?: string;
  /** "true" to additionally accept localhost origins (development only). */
  ALLOW_LOCAL_DEV?: string;
}

export interface ApiConfig {
  models: {
    /** Speech-to-text model. */
    transcription: '@cf/openai/whisper-large-v3-turbo';
    /** Dedicated machine-translation model (not a chat LLM). */
    translation: '@cf/meta/m2m100-1.2b';
  };
  limits: {
    maxAudioBytes: number;
    maxUtteranceMs: number;
    maxTextLength: number;
    maxRequestIdLength: number;
  };
  cors: {
    allowedOrigins: readonly string[];
    allowLocalDev: boolean;
  };
}

export function configFromEnv(env: Env): ApiConfig {
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    models: {
      transcription: '@cf/openai/whisper-large-v3-turbo',
      translation: '@cf/meta/m2m100-1.2b',
    },
    limits: {
      maxAudioBytes: API_LIMITS.maxAudioBytes,
      maxUtteranceMs: API_LIMITS.maxUtteranceMs,
      maxTextLength: API_LIMITS.maxTextLength,
      maxRequestIdLength: API_LIMITS.maxRequestIdLength,
    },
    cors: {
      allowedOrigins,
      allowLocalDev: env.ALLOW_LOCAL_DEV === 'true',
    },
  };
}
