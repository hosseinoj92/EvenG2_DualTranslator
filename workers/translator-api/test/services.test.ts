import { describe, expect, it } from 'vitest';
import { arrayBufferToBase64, normalizeTranscript } from '../src/services/transcriptionService';
import { normalizeTranslation } from '../src/services/translationService';

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
