/**
 * Test utilities: an app factory with mockable services and a synthetic WAV
 * builder. No real Workers AI model is ever called from unit tests.
 */

import type { AppDependencies, AppFetch } from '../src/index';
import { createApp } from '../src/index';
import type { ApiConfig } from '../src/env';
import { configFromEnv } from '../src/env';
import type { TranscriptionService } from '../src/services/transcriptionService';
import type { TranslationService } from '../src/services/translationService';

export const BASE_URL = 'https://api.test';

export function testConfig(overrides?: {
  allowedOrigins?: string;
  allowLocalDev?: string;
}): ApiConfig {
  // `AI` is never touched by unit tests; configFromEnv only reads vars.
  return configFromEnv({
    AI: undefined as unknown as Ai,
    ALLOWED_ORIGINS: overrides?.allowedOrigins ?? 'https://app.example',
    ALLOW_LOCAL_DEV: overrides?.allowLocalDev ?? 'false',
  });
}

export function mockTranscription(impl?: TranscriptionService['transcribe']): TranscriptionService {
  return { transcribe: impl ?? (async () => 'hola mundo') };
}

export function mockTranslation(impl?: TranslationService['translate']): TranslationService {
  return { translate: impl ?? (async () => 'hello world') };
}

export function buildApp(partial?: Partial<AppDependencies>): AppFetch {
  return createApp({
    config: partial?.config ?? testConfig(),
    transcription: partial?.transcription ?? mockTranscription(),
    translation: partial?.translation ?? mockTranslation(),
  });
}

/**
 * Builds a structurally valid 16 kHz mono s16le WAV payload of the requested
 * duration (all-zero samples — content does not matter for routing tests).
 */
export function makeWavBytes(durationMs: number, sampleRateHz = 16_000): Uint8Array {
  const bytesPerSample = 2;
  const byteRate = sampleRateHz * bytesPerSample;
  const dataSize = Math.round((durationMs / 1000) * byteRate);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}

export interface InterpretFormOverrides {
  audio?: File | null;
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
  direction?: string | null;
  requestId?: string | null;
}

export function makeInterpretRequest(overrides: InterpretFormOverrides = {}): Request {
  const form = new FormData();
  const audio =
    overrides.audio === undefined
      ? new File([makeWavBytes(1000)], 'utterance.wav', { type: 'audio/wav' })
      : overrides.audio;
  if (audio) form.append('audio', audio);

  const fields: Record<string, string | null | undefined> = {
    sourceLanguage: overrides.sourceLanguage === undefined ? 'es' : overrides.sourceLanguage,
    targetLanguage: overrides.targetLanguage === undefined ? 'en' : overrides.targetLanguage,
    direction: overrides.direction === undefined ? 'them-to-me' : overrides.direction,
    requestId: overrides.requestId === undefined ? 'req-123' : overrides.requestId,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) form.append(key, value);
  }

  return new Request(`${BASE_URL}/api/v1/interpret`, { method: 'POST', body: form });
}

export interface TranscribeFormOverrides {
  audio?: File | null;
  sourceLanguage?: string | null;
  requestId?: string | null;
}

export function makeTranscribeRequest(overrides: TranscribeFormOverrides = {}): Request {
  const form = new FormData();
  const audio =
    overrides.audio === undefined
      ? new File([makeWavBytes(1000)], 'utterance.wav', { type: 'audio/wav' })
      : overrides.audio;
  if (audio) form.append('audio', audio);

  const fields: Record<string, string | null | undefined> = {
    sourceLanguage: overrides.sourceLanguage === undefined ? 'es' : overrides.sourceLanguage,
    requestId: overrides.requestId === undefined ? 'req-123' : overrides.requestId,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) form.append(key, value);
  }

  return new Request(`${BASE_URL}/api/v1/transcribe`, { method: 'POST', body: form });
}

export function makeTranslateTextRequest(body: unknown): Request {
  return new Request(`${BASE_URL}/api/v1/translate-text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
