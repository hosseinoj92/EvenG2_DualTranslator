/**
 * Worker entry point. `createApp` is a pure factory over injected services so
 * unit tests can exercise routing, CORS and orchestration with mocks; the
 * default export wires it to the real Workers AI binding.
 */

import { API_PATHS } from '@turntranslate/shared';
import type { ApiConfig, Env } from './env';
import { configFromEnv } from './env';
import { notFound, securityHeaders, toErrorResponse } from './errors';
import { handleHealth } from './routes/health';
import { handleInterpret } from './routes/interpret';
import { handleTranscribe } from './routes/transcribe';
import { handleTranslateText } from './routes/translateText';
import type { TranscriptionService } from './services/transcriptionService';
import { createWorkersAiTranscriptionService } from './services/transcriptionService';
import type { TranslationService } from './services/translationService';
import { createTranslationService } from './services/translationService';

export interface AppDependencies {
  config: ApiConfig;
  transcription: TranscriptionService;
  translation: TranslationService;
}

export type AppFetch = (request: Request) => Promise<Response>;

export function createApp(deps: AppDependencies): AppFetch {
  return async (request) => {
    const url = new URL(request.url);
    const corsHeaders = buildCorsHeaders(request.headers.get('origin'), deps.config);

    if (request.method === 'OPTIONS') {
      return handlePreflight(corsHeaders);
    }

    switch (url.pathname) {
      case API_PATHS.health:
        return handleHealth(request, deps.config, corsHeaders);
      case API_PATHS.interpret:
        return handleInterpret(request, deps, corsHeaders);
      case API_PATHS.transcribe:
        return handleTranscribe(request, deps, corsHeaders);
      case API_PATHS.translateText:
        return handleTranslateText(request, deps, corsHeaders);
      default:
        return toErrorResponse(notFound(), corsHeaders);
    }
  };
}

/**
 * CORS policy: echo the Origin header only when it is explicitly allowed.
 * Arbitrary origins are never reflected. Requests without an Origin header
 * (native fetches, including the Even Hub WebView) are unaffected by CORS.
 */
export function buildCorsHeaders(origin: string | null, config: ApiConfig): Record<string, string> {
  if (!origin || !isOriginAllowed(origin, config)) {
    return {};
  }
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function isOriginAllowed(origin: string, config: ApiConfig): boolean {
  if (config.cors.allowedOrigins.includes(origin)) {
    return true;
  }
  if (config.cors.allowLocalDev) {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }
  return false;
}

function handlePreflight(corsHeaders: Record<string, string>): Response {
  // 204 with allow-headers when permitted; a bare 204 otherwise (the browser
  // will then block the actual request — nothing to leak either way).
  return new Response(null, { status: 204, headers: { ...securityHeaders(), ...corsHeaders } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = configFromEnv(env);
    const app = createApp({
      config,
      transcription: createWorkersAiTranscriptionService(env.AI, config),
      translation: createTranslationService(env.AI, config),
    });
    return app(request);
  },
} satisfies ExportedHandler<Env>;
