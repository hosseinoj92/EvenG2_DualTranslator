/**
 * Worker environment bindings and the single backend configuration module.
 * Every model name, size limit and CORS rule lives here — routes and services
 * must not hard-code any of these values.
 */

import { API_LIMITS } from '@turntranslate/shared';

export interface Env {
  /** Workers AI binding, configured as `[ai] binding = "AI"` in wrangler.toml. */
  AI: Ai;
  /**
   * DeepL API key, set as a secret (`wrangler secret put DEEPL_API_KEY`, or
   * `.dev.vars` locally). When present, DeepL is the translation engine;
   * when absent, translation falls back to Workers AI m2m100.
   */
  DEEPL_API_KEY?: string;
  /** Comma-separated allowlist of CORS origins. May be empty. */
  ALLOWED_ORIGINS?: string;
  /** "true" to additionally accept localhost origins (development only). */
  ALLOW_LOCAL_DEV?: string;
}

export interface ApiConfig {
  models: {
    /** Speech-to-text model. */
    transcription: '@cf/openai/whisper-large-v3-turbo';
    /** Fallback machine-translation model used only without a DeepL key. */
    translation: '@cf/meta/m2m100-1.2b';
  };
  deepl: {
    /** Secret API key; empty string when not configured. */
    apiKey: string;
    /** Full /v2/translate endpoint, derived from the key type. */
    endpoint: string;
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

/**
 * DeepL free-tier keys carry the documented `:fx` suffix and must use the
 * api-free host; paid keys use the api host. Deriving this from the key means
 * upgrading the plan requires no config change.
 */
export function deeplEndpointForKey(apiKey: string): string {
  return apiKey.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
}

export function configFromEnv(env: Env): ApiConfig {
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const deeplApiKey = (env.DEEPL_API_KEY ?? '').trim();

  return {
    models: {
      transcription: '@cf/openai/whisper-large-v3-turbo',
      translation: '@cf/meta/m2m100-1.2b',
    },
    deepl: {
      apiKey: deeplApiKey,
      endpoint: deeplEndpointForKey(deeplApiKey),
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
