import { describe, expect, it } from 'vitest';
import {
  API_PATHS,
  isApiErrorResponse,
  isConversationDirection,
  isInterpretSuccessResponse,
  isTranscriptionSuccessResponse,
  isTranslateTextRequest,
} from '../src/index';

const validSuccess = {
  requestId: 'req-1',
  direction: 'them-to-me',
  sourceLanguage: 'es',
  targetLanguage: 'en',
  transcript: '¿Dónde está la estación?',
  translation: 'Where is the station?',
  processingTimeMs: 812,
  warnings: [],
};

describe('isInterpretSuccessResponse', () => {
  it('accepts a fully valid payload', () => {
    expect(isInterpretSuccessResponse(validSuccess)).toBe(true);
  });

  it('rejects missing or mistyped fields', () => {
    expect(isInterpretSuccessResponse({ ...validSuccess, requestId: 7 })).toBe(false);
    expect(isInterpretSuccessResponse({ ...validSuccess, direction: 'sideways' })).toBe(false);
    expect(isInterpretSuccessResponse({ ...validSuccess, sourceLanguage: 'xx' })).toBe(false);
    expect(isInterpretSuccessResponse({ ...validSuccess, translation: undefined })).toBe(false);
    expect(isInterpretSuccessResponse({ ...validSuccess, processingTimeMs: NaN })).toBe(false);
    expect(isInterpretSuccessResponse({ ...validSuccess, warnings: [1] })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isInterpretSuccessResponse(null)).toBe(false);
    expect(isInterpretSuccessResponse('ok')).toBe(false);
    expect(isInterpretSuccessResponse([validSuccess])).toBe(false);
  });
});

describe('API_PATHS', () => {
  it('exposes the transcription-only route alongside the existing routes', () => {
    expect(API_PATHS.transcribe).toBe('/api/v1/transcribe');
    expect(API_PATHS.interpret).toBe('/api/v1/interpret');
    expect(API_PATHS.translateText).toBe('/api/v1/translate-text');
  });
});

describe('isTranscriptionSuccessResponse', () => {
  const validTranscription = {
    requestId: 'req-9',
    sourceLanguage: 'es',
    transcript: '¿Dónde está la estación?',
    processingTimeMs: 412,
  };

  it('accepts a fully valid payload', () => {
    expect(isTranscriptionSuccessResponse(validTranscription)).toBe(true);
  });

  it('rejects missing or mistyped fields', () => {
    expect(isTranscriptionSuccessResponse({ ...validTranscription, requestId: 9 })).toBe(false);
    expect(isTranscriptionSuccessResponse({ ...validTranscription, sourceLanguage: 'xx' })).toBe(
      false,
    );
    expect(isTranscriptionSuccessResponse({ ...validTranscription, transcript: null })).toBe(false);
    expect(
      isTranscriptionSuccessResponse({ ...validTranscription, processingTimeMs: Infinity }),
    ).toBe(false);
    const { transcript: _omitted, ...withoutTranscript } = validTranscription;
    expect(isTranscriptionSuccessResponse(withoutTranscript)).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isTranscriptionSuccessResponse(null)).toBe(false);
    expect(isTranscriptionSuccessResponse('transcript')).toBe(false);
    expect(isTranscriptionSuccessResponse([validTranscription])).toBe(false);
  });
});

describe('isApiErrorResponse', () => {
  it('accepts the canonical error envelope', () => {
    expect(
      isApiErrorResponse({
        error: { code: 'NO_SPEECH_DETECTED', message: 'No speech detected', retryable: true },
      }),
    ).toBe(true);
  });

  it('rejects malformed envelopes', () => {
    expect(isApiErrorResponse({})).toBe(false);
    expect(isApiErrorResponse({ error: 'boom' })).toBe(false);
    expect(isApiErrorResponse({ error: { code: 1, message: 'x', retryable: true } })).toBe(false);
    expect(isApiErrorResponse({ error: { code: 'X', message: 'x', retryable: 'yes' } })).toBe(
      false,
    );
  });
});

describe('isTranslateTextRequest', () => {
  it('accepts a valid body', () => {
    expect(
      isTranslateTextRequest({
        text: 'Where is the station?',
        sourceLanguage: 'en',
        targetLanguage: 'es',
        direction: 'me-to-them',
        requestId: 'abc',
      }),
    ).toBe(true);
  });

  it('rejects invalid bodies', () => {
    expect(isTranslateTextRequest({ text: 'x' })).toBe(false);
    expect(
      isTranslateTextRequest({
        text: 'x',
        sourceLanguage: 'en',
        targetLanguage: 'en',
        direction: 'nowhere',
        requestId: 'abc',
      }),
    ).toBe(false);
  });
});

describe('isConversationDirection', () => {
  it('accepts both directions and nothing else', () => {
    expect(isConversationDirection('them-to-me')).toBe(true);
    expect(isConversationDirection('me-to-them')).toBe(true);
    expect(isConversationDirection('me-to-me')).toBe(false);
    expect(isConversationDirection(0)).toBe(false);
  });
});
