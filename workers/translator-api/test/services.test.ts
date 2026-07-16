import { afterEach, describe, expect, it, vi } from 'vitest';
import { arrayBufferToBase64, normalizeTranscript } from '../src/services/transcriptionService';
import {
  activeTranslationEngine,
  createDeepLTranslationService,
  createTranslationService,
  deeplHttpError,
  normalizeDeepLTranslation,
  normalizeTranslation,
} from '../src/services/translationService';
import { deeplEndpointForKey } from '../src/env';
import { ApiError } from '../src/errors';
import { testConfig } from './helpers';

describe('arrayBufferToBase64', () => {
  it('encodes small buffers correctly', () => {
    const bytes = new TextEncoder().encode('hello');
    expect(arrayBufferToBase64(bytes.buffer as ArrayBuffer)).toBe('aGVsbG8=');
  });

  it('round-trips buffers larger than one chunk', () => {
    const size = 0x2000 * 3 + 17;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = i % 256;
    const encoded = arrayBufferToBase64(bytes.buffer as ArrayBuffer);
    const decoded = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });
});

describe('normalizeTranscript', () => {
  it('reads the documented text field', () => {
    expect(normalizeTranscript({ text: ' Hola mundo ' })).toBe('Hola mundo');
  });

  it('falls back to segments when text is absent', () => {
    expect(normalizeTranscript({ segments: [{ text: 'Hola' }, { text: 'mundo' }] })).toBe(
      'Hola mundo',
    );
  });

  it('returns empty string for unusable payloads', () => {
    expect(normalizeTranscript(null)).toBe('');
    expect(normalizeTranscript({ words: 3 })).toBe('');
    expect(normalizeTranscript({ text: '   ' })).toBe('');
  });
});

describe('normalizeTranslation', () => {
  it('reads the documented translated_text field', () => {
    expect(normalizeTranslation({ translated_text: ' Hello ' })).toBe('Hello');
  });

  it('returns empty string for unusable payloads', () => {
    expect(normalizeTranslation(undefined)).toBe('');
    expect(normalizeTranslation({})).toBe('');
  });
});

describe('translation engine selection', () => {
  it('activates DeepL exactly when a key is configured', () => {
    expect(activeTranslationEngine(testConfig())).toBe('workers-ai');
    expect(activeTranslationEngine(testConfig({ deeplApiKey: 'key:fx' }))).toBe('deepl');
  });

  it('derives the endpoint from the key type (":fx" = free tier)', () => {
    expect(deeplEndpointForKey('abc:fx')).toBe('https://api-free.deepl.com/v2/translate');
    expect(deeplEndpointForKey('abc')).toBe('https://api.deepl.com/v2/translate');
  });

  it('createTranslationService falls back to Workers AI without a key', async () => {
    const ai = { run: vi.fn(async () => ({ translated_text: 'hello' })) };
    const service = createTranslationService(ai as unknown as Ai, testConfig());
    await expect(service.translate('hola', 'es', 'en')).resolves.toBe('hello');
    expect(ai.run).toHaveBeenCalledTimes(1);
  });
});

describe('DeepL translation service', () => {
  const config = testConfig({ deeplApiKey: 'secret-key:fx' });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: Response): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('sends the documented request and returns the translation', async () => {
    const fetchMock = stubFetch(
      new Response(
        JSON.stringify({
          translations: [{ detected_source_language: 'ES', text: ' Where is the station? ' }],
        }),
        { status: 200 },
      ),
    );

    const service = createDeepLTranslationService(config);
    const result = await service.translate('¿Dónde está la estación?', 'es', 'en');
    expect(result).toBe('Where is the station?');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api-free.deepl.com/v2/translate');
    expect(new Headers(init.headers).get('authorization')).toBe('DeepL-Auth-Key secret-key:fx');
    expect(JSON.parse(init.body as string)).toEqual({
      text: ['¿Dónde está la estación?'],
      source_lang: 'ES',
      // Plain "EN" is a deprecated DeepL target; the app pins EN-US.
      target_lang: 'EN-US',
    });
  });

  it('maps Portuguese to the regional PT-PT target', async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ translations: [{ text: 'Onde fica a estação?' }] }), {
        status: 200,
      }),
    );
    const service = createDeepLTranslationService(config);
    await service.translate('Where is the station?', 'en', 'pt');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      source_lang: 'EN',
      target_lang: 'PT-PT',
    });
  });

  it('reports an exhausted quota as a non-retryable failure', async () => {
    stubFetch(new Response('Quota exceeded', { status: 456 }));
    const service = createDeepLTranslationService(config);
    const failure = await service.translate('hola', 'es', 'en').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('TRANSLATION_FAILED');
    expect((failure as ApiError).retryable).toBe(false);
    expect((failure as ApiError).message).toContain('quota');
  });

  it('treats rate limiting as retryable and bad keys as not retryable', () => {
    expect(deeplHttpError(429).retryable).toBe(true);
    expect(deeplHttpError(403).retryable).toBe(false);
    expect(deeplHttpError(500).retryable).toBe(true);
  });

  it('fails cleanly when the network call itself throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    const service = createDeepLTranslationService(config);
    const failure = await service.translate('hola', 'es', 'en').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).retryable).toBe(true);
  });

  it('rejects empty or malformed response bodies', async () => {
    stubFetch(new Response(JSON.stringify({ translations: [] }), { status: 200 }));
    const service = createDeepLTranslationService(config);
    await expect(service.translate('hola', 'es', 'en')).rejects.toMatchObject({
      code: 'TRANSLATION_FAILED',
    });
  });
});

describe('normalizeDeepLTranslation', () => {
  it('reads the first translation text', () => {
    expect(normalizeDeepLTranslation({ translations: [{ text: ' Hello ' }] })).toBe('Hello');
  });

  it('returns empty string for unusable payloads', () => {
    expect(normalizeDeepLTranslation(undefined)).toBe('');
    expect(normalizeDeepLTranslation({})).toBe('');
    expect(normalizeDeepLTranslation({ translations: [] })).toBe('');
    expect(normalizeDeepLTranslation({ translations: [{ no_text: true }] })).toBe('');
  });
});
