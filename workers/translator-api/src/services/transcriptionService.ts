/**
 * Speech-to-text behind a provider-agnostic interface so another vendor can
 * be swapped in without touching the routes. The default implementation uses
 * Workers AI `@cf/openai/whisper-large-v3-turbo`.
 */

import type { LanguageCode } from '@turntranslate/shared';
import { ApiError } from '../errors';
import type { ApiConfig } from '../env';

export interface TranscriptionService {
  /**
   * Transcribes a WAV payload in the given language and returns the plain
   * transcript text. Throws `ApiError('NO_SPEECH_DETECTED')` when the model
   * hears nothing, and `ApiError('TRANSCRIPTION_FAILED')` on upstream errors.
   */
  transcribe(audio: ArrayBuffer, language: LanguageCode): Promise<string>;
}

export function createWorkersAiTranscriptionService(
  ai: Ai,
  config: ApiConfig,
): TranscriptionService {
  return {
    async transcribe(audio, language) {
      let raw: unknown;
      try {
        // whisper-large-v3-turbo takes base64 audio. `vad_filter` trims long
        // silences upstream. Disabling `condition_on_previous_text` prevents
        // unrelated text from previous decoding context influencing this utterance.
        raw = await ai.run(config.models.transcription, {
          audio: arrayBufferToBase64(audio),
          task: 'transcribe',
          language,
          vad_filter: true,
          condition_on_previous_text: false,
        });
      } catch (error) {
        console.error('workers-ai transcription failed:', describeUpstreamError(error));
        throw new ApiError('TRANSCRIPTION_FAILED', 502, 'Speech recognition failed', true);
      }

      const transcript = normalizeTranscript(raw);
      if (!transcript) {
        throw new ApiError('NO_SPEECH_DETECTED', 422, 'No speech was detected in the audio', true);
      }
      return transcript;
    },
  };
}

/**
 * Base64-encodes an ArrayBuffer with `btoa`, which Workers provide natively —
 * no Node compatibility flag is needed. Encoding is chunked so
 * `String.fromCharCode` never receives more arguments than the engine allows.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x2000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * The documented output shape is `{ text: string, ... }`, but the field has
 * moved between model revisions before, so nearby shapes are tolerated.
 */
export function normalizeTranscript(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw !== 'object' || raw === null) return '';
  const record = raw as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text.trim();
  if (typeof record.transcription === 'string') return record.transcription.trim();
  if (Array.isArray(record.segments)) {
    const joined = record.segments
      .map((segment) =>
        typeof segment === 'object' && segment !== null
          ? String((segment as Record<string, unknown>).text ?? '')
          : '',
      )
      .join(' ')
      .trim();
    if (joined) return joined;
  }
  return '';
}

function describeUpstreamError(error: unknown): string {
  // Log a structured summary only — never the audio payload itself.
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
