/**
 * Request validation for both endpoints. All external input crosses this
 * module before touching a service; anything invalid becomes a typed
 * `ApiError` with an appropriate HTTP status.
 */

import type { ConversationDirection, LanguageCode } from '@turntranslate/shared';
import { isConversationDirection, isTranslateTextRequest } from '@turntranslate/shared';
import { ApiError, badRequest } from './errors';
import type { ApiConfig } from './env';
import { validateLanguagePairOrThrow } from './services/languageService';

export interface ValidatedInterpretRequest {
  audio: ArrayBuffer;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  direction: ConversationDirection;
  requestId: string;
  warnings: string[];
}

export interface ValidatedTranslateTextRequest {
  text: string;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  direction: ConversationDirection;
  requestId: string;
}

const ACCEPTED_AUDIO_MIME_PREFIXES = ['audio/wav', 'audio/x-wav', 'audio/wave'];

export async function parseInterpretRequest(
  request: Request,
  config: ApiConfig,
): Promise<ValidatedInterpretRequest> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw badRequest('Expected multipart/form-data');
  }

  // Cheap pre-check before buffering the body.
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > config.limits.maxAudioBytes + 64 * 1024) {
    throw new ApiError('AUDIO_TOO_LARGE', 413, 'Uploaded audio exceeds the size limit');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw badRequest('Malformed multipart/form-data body');
  }

  const audioEntry = form.get('audio');
  if (audioEntry === null || typeof audioEntry === 'string') {
    throw badRequest('Missing "audio" file field');
  }
  const audioFile = audioEntry as File;

  const mime = (audioFile.type ?? '').toLowerCase();
  if (mime && !ACCEPTED_AUDIO_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) {
    throw badRequest(`Unsupported audio MIME type "${mime}"; expected audio/wav`);
  }

  if (audioFile.size === 0) {
    throw new ApiError('INVALID_AUDIO', 400, 'Uploaded audio file is empty');
  }
  if (audioFile.size > config.limits.maxAudioBytes) {
    throw new ApiError('AUDIO_TOO_LARGE', 413, 'Uploaded audio exceeds the size limit');
  }

  const requestId = readRequestId(form.get('requestId'), config);
  const direction = readDirection(form.get('direction'));
  const pair = validateLanguagePairOrThrow(form.get('sourceLanguage'), form.get('targetLanguage'));

  const audio = await audioFile.arrayBuffer();
  const warnings: string[] = [];
  validateWavPayload(audio, config, warnings);

  return {
    audio,
    sourceLanguage: pair.source.code,
    targetLanguage: pair.target.code,
    direction,
    requestId,
    warnings,
  };
}

export async function parseTranslateTextRequest(
  request: Request,
  config: ApiConfig,
): Promise<ValidatedTranslateTextRequest> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw badRequest('Expected application/json');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest('Malformed JSON body');
  }

  if (!isTranslateTextRequest(body)) {
    // Distinguish the two language failures so clients get actionable errors.
    if (typeof body === 'object' && body !== null) {
      const candidate = body as Record<string, unknown>;
      validateLanguagePairOrThrow(candidate.sourceLanguage, candidate.targetLanguage);
      if (!isConversationDirection(candidate.direction)) {
        throw badRequest('Field "direction" must be "them-to-me" or "me-to-them"');
      }
    }
    throw badRequest(
      'Body must contain text, sourceLanguage, targetLanguage, direction, requestId',
    );
  }

  const requestId = readRequestId(body.requestId, config);
  const text = body.text.trim();
  if (text.length === 0) {
    throw badRequest('Field "text" must not be empty');
  }
  if (text.length > config.limits.maxTextLength) {
    throw badRequest(`Field "text" exceeds ${config.limits.maxTextLength} characters`);
  }
  // Guard once more so identical pairs are rejected with the dedicated code.
  const pair = validateLanguagePairOrThrow(body.sourceLanguage, body.targetLanguage);

  return {
    text,
    sourceLanguage: pair.source.code,
    targetLanguage: pair.target.code,
    direction: body.direction,
    requestId,
  };
}

function readRequestId(value: unknown, config: ApiConfig): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest('Missing "requestId" field');
  }
  const requestId = value.trim();
  if (requestId.length > config.limits.maxRequestIdLength) {
    throw badRequest(`"requestId" exceeds ${config.limits.maxRequestIdLength} characters`);
  }
  return requestId;
}

function readDirection(value: unknown): ConversationDirection {
  if (!isConversationDirection(value)) {
    throw badRequest('Field "direction" must be "them-to-me" or "me-to-them"');
  }
  return value;
}

/**
 * Structural WAV sanity check. Rejects non-RIFF payloads and utterances longer
 * than the configured maximum, using the byte rate declared in the header.
 * Tolerant by design: if the header is parseable but odd (e.g. unknown byte
 * rate), a warning is recorded instead of failing the request, since Whisper
 * itself is the final judge of decodability.
 */
export function validateWavPayload(
  audio: ArrayBuffer,
  config: ApiConfig,
  warnings: string[],
): void {
  if (audio.byteLength < 44) {
    throw new ApiError('INVALID_AUDIO', 400, 'Audio payload is too small to be a WAV file');
  }
  const view = new DataView(audio);
  const riff = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  const wave = String.fromCharCode(
    view.getUint8(8),
    view.getUint8(9),
    view.getUint8(10),
    view.getUint8(11),
  );
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new ApiError('INVALID_AUDIO', 400, 'Audio payload is not a RIFF/WAVE file');
  }

  // Byte rate lives at offset 28 of the canonical 44-byte header layout.
  const byteRate = view.getUint32(28, true);
  if (byteRate > 0) {
    const dataBytes = audio.byteLength - 44;
    const durationMs = (dataBytes / byteRate) * 1000;
    if (durationMs > config.limits.maxUtteranceMs + 1000) {
      throw new ApiError(
        'AUDIO_TOO_LONG',
        400,
        `Utterance is longer than the ${Math.round(config.limits.maxUtteranceMs / 1000)}s limit`,
      );
    }
  } else {
    warnings.push('WAV header declares an unknown byte rate; duration was not validated');
  }
}
