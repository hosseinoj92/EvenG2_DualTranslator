import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorResponse, InterpretSuccessResponse } from '@turntranslate/shared';
import { ApiError } from '../src/errors';
import { buildApp, makeTranslateTextRequest, mockTranslation, readJson } from './helpers';

const validBody = {
  text: 'Where is the station?',
  sourceLanguage: 'en',
  targetLanguage: 'es',
  direction: 'me-to-them',
  requestId: 'req-9',
};

describe('POST /api/v1/translate-text', () => {
  it('translates typed text and echoes it as transcript', async () => {
    const translate = vi.fn(async () => '¿Dónde está la estación?');
    const app = buildApp({ translation: mockTranslation(translate) });

    const response = await app(makeTranslateTextRequest(validBody));
    expect(response.status).toBe(200);
    const body = await readJson<InterpretSuccessResponse>(response);

    expect(body.transcript).toBe('Where is the station?');
    expect(body.translation).toBe('¿Dónde está la estación?');
    expect(body.direction).toBe('me-to-them');
    expect(body.requestId).toBe('req-9');
    expect(translate).toHaveBeenCalledWith('Where is the station?', 'en', 'es');
  });

  it('rejects malformed JSON', async () => {
    const app = buildApp();
    const response = await app(
      new Request('https://api.test/api/v1/translate-text', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects empty text', async () => {
    const app = buildApp();
    const response = await app(makeTranslateTextRequest({ ...validBody, text: '   ' }));
    expect(response.status).toBe(400);
  });

  it('rejects unsupported and equal language pairs', async () => {
    const app = buildApp();
    const unsupported = await app(makeTranslateTextRequest({ ...validBody, sourceLanguage: 'xx' }));
    expect(unsupported.status).toBe(400);
    expect((await readJson<ApiErrorResponse>(unsupported)).error.code).toBe('UNSUPPORTED_LANGUAGE');

    const equal = await app(
      makeTranslateTextRequest({ ...validBody, sourceLanguage: 'es', targetLanguage: 'es' }),
    );
    expect(equal.status).toBe(400);
    expect((await readJson<ApiErrorResponse>(equal)).error.code).toBe('SAME_LANGUAGE_PAIR');
  });

  it('maps translation service failures', async () => {
    const app = buildApp({
      translation: mockTranslation(async () => {
        throw new ApiError('TRANSLATION_FAILED', 502, 'Translation failed', true);
      }),
    });
    const response = await app(makeTranslateTextRequest(validBody));
    expect(response.status).toBe(502);
  });
});
