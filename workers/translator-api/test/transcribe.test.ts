import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorResponse, TranscriptionSuccessResponse } from '@turntranslate/shared';
import { isTranscriptionSuccessResponse } from '@turntranslate/shared';
import { ApiError } from '../src/errors';
import {
  BASE_URL,
  buildApp,
  makeTranscribeRequest,
  makeWavBytes,
  mockTranscription,
  mockTranslation,
  readJson,
  testConfig,
} from './helpers';

describe('POST /api/v1/transcribe — success', () => {
  it('returns the transcription-only contract without touching translation', async () => {
    const transcribe = vi.fn(async () => '¿Dónde está la estación?');
    const translate = vi.fn(async () => 'never called');
    const app = buildApp({
      transcription: mockTranscription(transcribe),
      translation: mockTranslation(translate),
    });

    const response = await app(makeTranscribeRequest());
    expect(response.status).toBe(200);
    const body = await readJson<TranscriptionSuccessResponse>(response);

    expect(isTranscriptionSuccessResponse(body)).toBe(true);
    expect(body.requestId).toBe('req-123');
    expect(body.sourceLanguage).toBe('es');
    expect(body.transcript).toBe('¿Dónde está la estación?');
    expect(body.processingTimeMs).toBeGreaterThanOrEqual(0);

    expect(transcribe).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'es');
    expect(translate).not.toHaveBeenCalled();
  });

  it('applies security headers to the response', async () => {
    const app = buildApp();
    const response = await app(makeTranscribeRequest());
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /api/v1/transcribe — validation', () => {
  it('rejects non-multipart bodies', async () => {
    const app = buildApp();
    const response = await app(
      new Request(`${BASE_URL}/api/v1/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects malformed multipart form data', async () => {
    const app = buildApp();
    const response = await app(
      new Request(`${BASE_URL}/api/v1/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=broken' },
        body: 'not really multipart',
      }),
    );
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects a form without an audio file', async () => {
    const app = buildApp();
    const response = await app(makeTranscribeRequest({ audio: null }));
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.message).toContain('audio');
  });

  it('rejects unsupported languages', async () => {
    const app = buildApp();
    const response = await app(makeTranscribeRequest({ sourceLanguage: 'xx' }));
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('UNSUPPORTED_LANGUAGE');
  });

  it('rejects a missing requestId', async () => {
    const app = buildApp();
    const response = await app(makeTranscribeRequest({ requestId: null }));
    expect(response.status).toBe(400);
  });

  it('rejects an overlong requestId', async () => {
    const app = buildApp();
    const response = await app(makeTranscribeRequest({ requestId: 'x'.repeat(65) }));
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.message).toContain('requestId');
  });

  it('rejects audio that is not RIFF/WAVE', async () => {
    const app = buildApp();
    const notWav = new File([new Uint8Array(2048)], 'utterance.wav', { type: 'audio/wav' });
    const response = await app(makeTranscribeRequest({ audio: notWav }));
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('INVALID_AUDIO');
  });

  it('rejects unsupported MIME types', async () => {
    const app = buildApp();
    const mp3 = new File([makeWavBytes(1000)], 'utterance.mp3', { type: 'audio/mpeg' });
    const response = await app(makeTranscribeRequest({ audio: mp3 }));
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.message).toContain('MIME');
  });

  it('rejects oversized audio with 413', async () => {
    const app = buildApp();
    const oversized = new File([new Uint8Array(4 * 1024 * 1024 + 1024)], 'utterance.wav', {
      type: 'audio/wav',
    });
    const response = await app(makeTranscribeRequest({ audio: oversized }));
    expect(response.status).toBe(413);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('AUDIO_TOO_LARGE');
  });

  it('rejects utterances longer than the limit', async () => {
    const app = buildApp();
    const tooLong = new File([makeWavBytes(20_000)], 'utterance.wav', { type: 'audio/wav' });
    const response = await app(makeTranscribeRequest({ audio: tooLong }));
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('AUDIO_TOO_LONG');
  });

  it('rejects GET with 405', async () => {
    const app = buildApp();
    const response = await app(new Request(`${BASE_URL}/api/v1/transcribe`, { method: 'GET' }));
    expect(response.status).toBe(405);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
  });
});

describe('POST /api/v1/transcribe — service failures', () => {
  it('surfaces NO_SPEECH_DETECTED through the typed error contract', async () => {
    const app = buildApp({
      transcription: mockTranscription(async () => {
        throw new ApiError('NO_SPEECH_DETECTED', 422, 'No speech was detected in the audio', true);
      }),
    });
    const response = await app(makeTranscribeRequest());
    expect(response.status).toBe(422);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error).toEqual({
      code: 'NO_SPEECH_DETECTED',
      message: 'No speech was detected in the audio',
      retryable: true,
    });
  });

  it('maps transcription-service failures to the typed error contract', async () => {
    const app = buildApp({
      transcription: mockTranscription(async () => {
        throw new ApiError('TRANSCRIPTION_FAILED', 502, 'Speech recognition failed', true);
      }),
    });
    const response = await app(makeTranscribeRequest());
    expect(response.status).toBe(502);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('TRANSCRIPTION_FAILED');
  });

  it('converts unexpected exceptions into a generic 500', async () => {
    const app = buildApp({
      transcription: mockTranscription(async () => {
        throw new TypeError('boom with internals: /secret/path');
      }),
    });
    const response = await app(makeTranscribeRequest());
    expect(response.status).toBe(500);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).not.toContain('secret');
  });
});

describe('POST /api/v1/transcribe — CORS', () => {
  it('answers preflight from an allowed origin', async () => {
    const app = buildApp({ config: testConfig({ allowedOrigins: 'https://app.example' }) });
    const response = await app(
      new Request(`${BASE_URL}/api/v1/transcribe`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.example',
          'access-control-request-method': 'POST',
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('adds CORS headers to successful responses for allowed origins', async () => {
    const app = buildApp({ config: testConfig({ allowedOrigins: 'https://app.example' }) });
    const form = new FormData();
    form.append('audio', new File([makeWavBytes(1000)], 'utterance.wav', { type: 'audio/wav' }));
    form.append('sourceLanguage', 'es');
    form.append('requestId', 'req-123');
    const response = await app(
      new Request(`${BASE_URL}/api/v1/transcribe`, {
        method: 'POST',
        headers: { origin: 'https://app.example' },
        body: form,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });
});
