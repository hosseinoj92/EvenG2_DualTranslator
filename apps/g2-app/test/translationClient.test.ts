import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InterpretSuccessResponse } from '@turntranslate/shared';
import { TranslationClientError } from '../src/api/apiErrors';
import { createTranslationClient } from '../src/api/translationClient';

const client = () => createTranslationClient({ baseUrl: 'https://api.test', timeoutMs: 100 });

function successPayload(requestId: string): InterpretSuccessResponse {
  return {
    requestId,
    direction: 'them-to-me',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    transcript: 'hola',
    translation: 'hello',
    processingTimeMs: 5,
    warnings: [],
  };
}

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => response);
  vi.stubGlobal('fetch', mock);
  return mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const params = {
  wav: new Blob([new Uint8Array(64)], { type: 'audio/wav' }),
  sourceLanguage: 'es',
  targetLanguage: 'en',
  direction: 'them-to-me',
  requestId: 'req-1',
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('translationClient', () => {
  it('returns a validated success payload', async () => {
    const mock = stubFetch(jsonResponse(successPayload('req-1')));
    const result = await client().interpretUtterance(params);
    expect(result.translation).toBe('hello');
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/v1/interpret');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('rejects stale responses whose requestId does not match', async () => {
    stubFetch(jsonResponse(successPayload('req-OTHER')));
    await expect(client().interpretUtterance(params)).rejects.toMatchObject({
      code: 'STALE_RESPONSE',
    });
  });

  it('maps backend error envelopes to typed errors', async () => {
    stubFetch(
      jsonResponse(
        { error: { code: 'NO_SPEECH_DETECTED', message: 'nothing heard', retryable: true } },
        422,
      ),
    );
    const failure = await client()
      .interpretUtterance(params)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TranslationClientError);
    const typed = failure as TranslationClientError;
    expect(typed.code).toBe('NO_SPEECH_DETECTED');
    expect(typed.retryable).toBe(true);
    expect(typed.userMessage).toContain('No speech');
  });

  it('treats malformed success bodies as protocol errors', async () => {
    stubFetch(jsonResponse({ hello: 'world' }));
    await expect(client().interpretUtterance(params)).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('treats non-JSON replies as protocol errors', async () => {
    stubFetch(new Response('<html>oops</html>', { status: 200 }));
    await expect(client().interpretUtterance(params)).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('converts fetch failures into a retryable network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const failure = await client()
      .interpretUtterance(params)
      .catch((error: unknown) => error as TranslationClientError);
    expect(failure).toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
  });

  it('times out hung requests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    await expect(client().interpretUtterance(params)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('maps external aborts to CANCELLED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    const controller = new AbortController();
    const pending = client().interpretUtterance({ ...params, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('posts transcribeFinal to /api/v1/transcribe and validates the payload', async () => {
    const mock = stubFetch(
      jsonResponse({
        requestId: 'req-1',
        sourceLanguage: 'es',
        transcript: '¿Dónde está la estación?',
        processingTimeMs: 300,
      }),
    );
    const result = await client().transcribeFinal({
      wav: params.wav,
      sourceLanguage: 'es',
      requestId: 'req-1',
    });
    expect(result.transcript).toBe('¿Dónde está la estación?');
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/v1/transcribe');
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get('sourceLanguage')).toBe('es');
    expect(form.get('requestId')).toBe('req-1');
    expect(form.has('targetLanguage')).toBe(false);
  });

  it('rejects stale transcribeFinal responses', async () => {
    stubFetch(
      jsonResponse({
        requestId: 'req-OTHER',
        sourceLanguage: 'es',
        transcript: 'hola',
        processingTimeMs: 5,
      }),
    );
    await expect(
      client().transcribeFinal({ wav: params.wav, sourceLanguage: 'es', requestId: 'req-1' }),
    ).rejects.toMatchObject({ code: 'STALE_RESPONSE' });
  });

  it('treats malformed transcribeFinal bodies as protocol errors', async () => {
    stubFetch(jsonResponse({ requestId: 'req-1', transcript: 42 }));
    await expect(
      client().transcribeFinal({ wav: params.wav, sourceLanguage: 'es', requestId: 'req-1' }),
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('maps transcribeFinal backend errors to typed errors', async () => {
    stubFetch(
      jsonResponse(
        { error: { code: 'NO_SPEECH_DETECTED', message: 'nothing heard', retryable: true } },
        422,
      ),
    );
    await expect(
      client().transcribeFinal({ wav: params.wav, sourceLanguage: 'es', requestId: 'req-1' }),
    ).rejects.toMatchObject({ code: 'NO_SPEECH_DETECTED', retryable: true });
  });

  it('sends translate-text as JSON and validates the echo', async () => {
    stubFetch(jsonResponse({ ...successPayload('req-1'), direction: 'me-to-them' }));
    const result = await client().translateText({
      text: 'hello',
      sourceLanguage: 'en',
      targetLanguage: 'es',
      direction: 'me-to-them',
      requestId: 'req-1',
    });
    expect(result.direction).toBe('me-to-them');
  });
});
