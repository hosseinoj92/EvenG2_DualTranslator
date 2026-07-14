import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorResponse, InterpretSuccessResponse } from '@turntranslate/shared';
import { ApiError } from '../src/errors';
import {
  BASE_URL,
  buildApp,
  makeInterpretRequest,
  makeWavBytes,
  mockTranscription,
  mockTranslation,
  readJson,
} from './helpers';

describe('POST /api/v1/interpret — validation', () => {
  it('rejects non-multipart bodies', async () => {
    const app = buildApp();
    const response = await app(
      new Request(`${BASE_URL}/api/v1/interpret`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects GET with 405', async () => {
    const app = buildApp();
    const response = await app(new Request(`${BASE_URL}/api/v1/interpret`, { method: 'GET' }));
    expect(response.status).toBe(405);
  });

  it('rejects a form without an audio file', async () => {
    const app = buildApp();
    const response = await app(makeInterpretRequest({ audio: null }));
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.message).toContain('audio');
  });

  it('rejects unsupported languages', async () => {
    const app = buildApp();
    const response = await app(makeInterpretRequest({ sourceLanguage: 'xx' }));
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('UNSUPPORTED_LANGUAGE');
  });

  it('rejects equal source and target languages', async () => {
    const app = buildApp();
    const response = await app(
      makeInterpretRequest({ sourceLanguage: 'en', targetLanguage: 'en' }),
    );
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('SAME_LANGUAGE_PAIR');
  });

  it('rejects an invalid direction', async () => {
    const app = buildApp();
    const response = await app(makeInterpretRequest({ direction: 'sideways' }));
    expect(response.status).toBe(400);
  });

  it('rejects a missing requestId', async () => {
    const app = buildApp();
    const response = await app(makeInterpretRequest({ requestId: null }));
    expect(response.status).toBe(400);
  });

  it('rejects oversized audio with 413', async () => {
    const app = buildApp();
    const oversized = new File([new Uint8Array(4 * 1024 * 1024 + 1024)], 'utterance.wav', {
      type: 'audio/wav',
    });
    const response = await app(makeInterpretRequest({ audio: oversized }));
    expect(response.status).toBe(413);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('AUDIO_TOO_LARGE');
  });

  it('rejects audio that is not RIFF/WAVE', async () => {
    const app = buildApp();
    const notWav = new File([new Uint8Array(2048)], 'utterance.wav', {
      type: 'audio/wav',
    });
    const response = await app(makeInterpretRequest({ audio: notWav }));
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('INVALID_AUDIO');
  });

  it('rejects utterances longer than the limit', async () => {
    const app = buildApp();
    const tooLong = new File([makeWavBytes(20_000)], 'utterance.wav', {
      type: 'audio/wav',
    });
    const response = await app(makeInterpretRequest({ audio: tooLong }));
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('AUDIO_TOO_LONG');
  });
});

describe('POST /api/v1/interpret — orchestration', () => {
  it('returns the full success contract using both services', async () => {
    const transcribe = vi.fn(async () => '¿Dónde está la estación?');
    const translate = vi.fn(async () => 'Where is the station?');
    const app = buildApp({
      transcription: mockTranscription(transcribe),
      translation: mockTranslation(translate),
    });

    const response = await app(makeInterpretRequest());
    expect(response.status).toBe(200);
    const body = await readJson<InterpretSuccessResponse>(response);

    expect(body.requestId).toBe('req-123');
    expect(body.direction).toBe('them-to-me');
    expect(body.sourceLanguage).toBe('es');
    expect(body.targetLanguage).toBe('en');
    expect(body.transcript).toBe('¿Dónde está la estación?');
    expect(body.translation).toBe('Where is the station?');
    expect(body.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(body.warnings).toEqual([]);

    expect(transcribe).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'es');
    expect(translate).toHaveBeenCalledWith('¿Dónde está la estación?', 'es', 'en');
  });

  it('maps transcription failures to the typed error contract', async () => {
    const app = buildApp({
      transcription: mockTranscription(async () => {
        throw new ApiError('TRANSCRIPTION_FAILED', 502, 'Speech recognition failed', true);
      }),
    });
    const response = await app(makeInterpretRequest());
    expect(response.status).toBe(502);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error).toEqual({
      code: 'TRANSCRIPTION_FAILED',
      message: 'Speech recognition failed',
      retryable: true,
    });
  });

  it('surfaces NO_SPEECH_DETECTED as retryable 422', async () => {
    const app = buildApp({
      transcription: mockTranscription(async () => {
        throw new ApiError('NO_SPEECH_DETECTED', 422, 'No speech was detected in the audio', true);
      }),
    });
    const response = await app(makeInterpretRequest());
    expect(response.status).toBe(422);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('NO_SPEECH_DETECTED');
    expect(body.error.retryable).toBe(true);
  });

  it('maps translation failures without exposing internals', async () => {
    const app = buildApp({
      translation: mockTranslation(async () => {
        throw new ApiError('TRANSLATION_FAILED', 502, 'Translation failed', true);
      }),
    });
    const response = await app(makeInterpretRequest());
    expect(response.status).toBe(502);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('TRANSLATION_FAILED');
  });

  it('converts unexpected exceptions into a generic 500', async () => {
    const app = buildApp({
      transcription: mockTranscription(async () => {
        throw new TypeError('boom with secrets: /internal/path');
      }),
    });
    const response = await app(makeInterpretRequest());
    expect(response.status).toBe(500);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).not.toContain('secrets');
  });
});
