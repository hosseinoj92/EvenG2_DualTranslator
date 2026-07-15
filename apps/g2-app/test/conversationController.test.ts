/**
 * Orchestration tests for the two-stage voice chain (final transcription →
 * translation). The real VAD is driven with synthetic PCM frames; the
 * TranslationClient is a controllable mock, so stage ordering, cancellation
 * and staleness can be asserted deterministically.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InterpretSuccessResponse, TranscriptionSuccessResponse } from '@turntranslate/shared';
import { appConfig } from '../src/config';
import type {
  InterpretParams,
  TranscribeFinalParams,
  TranslateTextParams,
  TranslationClient,
} from '../src/api/translationClient';
import { TranslationClientError } from '../src/api/apiErrors';
import { ConversationController } from '../src/conversation/conversationController';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Avoid unhandled-rejection noise when a test rejects an awaited-later promise.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

class MockClient implements TranslationClient {
  transcribeCalls: TranscribeFinalParams[] = [];
  translateCalls: TranslateTextParams[] = [];
  transcribeResults: Deferred<TranscriptionSuccessResponse>[] = [];
  translateResults: Deferred<InterpretSuccessResponse>[] = [];
  interpretCalls: InterpretParams[] = [];

  /** When false, aborts are ignored so "stale" responses can still arrive. */
  constructor(private readonly respectAbort = true) {}

  async interpretUtterance(params: InterpretParams): Promise<InterpretSuccessResponse> {
    this.interpretCalls.push(params);
    throw new Error('interpretUtterance must not be used by the two-stage chain');
  }

  transcribeFinal(params: TranscribeFinalParams): Promise<TranscriptionSuccessResponse> {
    this.transcribeCalls.push(params);
    const result = deferred<TranscriptionSuccessResponse>();
    this.transcribeResults.push(result);
    if (this.respectAbort) {
      params.signal?.addEventListener('abort', () =>
        result.reject(TranslationClientError.cancelled()),
      );
    }
    return result.promise;
  }

  translateText(params: TranslateTextParams): Promise<InterpretSuccessResponse> {
    this.translateCalls.push(params);
    const result = deferred<InterpretSuccessResponse>();
    this.translateResults.push(result);
    if (this.respectAbort) {
      params.signal?.addEventListener('abort', () =>
        result.reject(TranslationClientError.cancelled()),
      );
    }
    return result.promise;
  }

  resolveTranscription(index: number, transcript: string): void {
    const params = this.transcribeCalls[index]!;
    this.transcribeResults[index]!.resolve({
      requestId: params.requestId,
      sourceLanguage: params.sourceLanguage,
      transcript,
      processingTimeMs: 5,
    });
  }

  resolveTranslation(index: number, translation: string): void {
    const params = this.translateCalls[index]!;
    this.translateResults[index]!.resolve({
      requestId: params.requestId,
      direction: params.direction,
      sourceLanguage: params.sourceLanguage,
      targetLanguage: params.targetLanguage,
      transcript: params.text,
      translation,
      processingTimeMs: 5,
      warnings: [],
    });
  }
}

function makeController(client: TranslationClient): ConversationController {
  return new ConversationController({
    config: appConfig,
    client,
    microphone: null,
    settings: { myLanguage: 'en', otherLanguage: 'es' },
  });
}

// ----- synthetic audio ------------------------------------------------------

const FRAME_BYTES =
  ((appConfig.vad.sampleRateHz * (appConfig.vad.bitsPerSample / 8) * appConfig.vad.channels) /
    1000) *
  appConfig.vad.frameMs;

function pcmFrame(amplitude: number): Uint8Array {
  const frame = new Uint8Array(FRAME_BYTES);
  const view = new DataView(frame.buffer);
  for (let i = 0; i < FRAME_BYTES / 2; i += 1) {
    view.setInt16(i * 2, amplitude, true);
  }
  return frame;
}

/** Pushes a complete spoken utterance (speech + closing silence) through the VAD. */
function speak(controller: ConversationController): void {
  for (let i = 0; i < 25; i += 1) controller.handleAudioFrame(pcmFrame(8000));
  const silentFrames = Math.ceil(appConfig.vad.endSilenceMs / appConfig.vad.frameMs) + 2;
  for (let i = 0; i < silentFrames; i += 1) controller.handleAudioFrame(pcmFrame(0));
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('two-stage voice chain', () => {
  it('calls transcription first and does not translate until it succeeds', async () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);

    expect(client.transcribeCalls).toHaveLength(1);
    expect(client.translateCalls).toHaveLength(0);
    expect(client.interpretCalls).toHaveLength(0);
    expect(controller.snapshot().status).toBe('PROCESSING_THEM');
    expect(controller.snapshot().processingPhase).toBe('transcribing');

    client.resolveTranscription(0, '¿Dónde está la estación?');
    await flush();
    expect(client.translateCalls).toHaveLength(1);
    controller.dispose();
  });

  it('sends exactly one transcription request per utterance', async () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);
    client.resolveTranscription(0, 'hola');
    await flush();
    client.resolveTranslation(0, 'hello');
    await flush();

    expect(client.transcribeCalls).toHaveLength(1);
    expect(client.transcribeCalls[0]!.sourceLanguage).toBe('es');
    controller.dispose();
  });

  it('makes the transcript visible before translation resolves', async () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);

    client.resolveTranscription(0, '¿Dónde está la estación?');
    await flush();

    const snapshot = controller.snapshot();
    expect(snapshot.currentTranscript).toBe('¿Dónde está la estación?');
    expect(snapshot.processingPhase).toBe('translating');
    expect(snapshot.status).toBe('PROCESSING_THEM');
    expect(snapshot.history).toHaveLength(0); // Not a completed turn yet.
    controller.dispose();
  });

  it('passes exactly the returned transcript to translation', async () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);

    client.resolveTranscription(0, '  ¿Dónde está la estación?');
    await flush();

    expect(client.translateCalls[0]!.text).toBe('  ¿Dónde está la estación?');
    expect(client.translateCalls[0]!.sourceLanguage).toBe('es');
    expect(client.translateCalls[0]!.targetLanguage).toBe('en');
    expect(client.translateCalls[0]!.direction).toBe('them-to-me');
    expect(client.translateCalls[0]!.requestId).toBe(client.transcribeCalls[0]!.requestId);
    controller.dispose();
  });

  it('produces a completed turn containing both transcript and translation', async () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);

    client.resolveTranscription(0, '¿Dónde está la estación?');
    await flush();
    client.resolveTranslation(0, 'Where is the station?');
    await flush();

    const snapshot = controller.snapshot();
    expect(snapshot.status).toBe('SHOWING_THEM_RESULT');
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.latestTurn).toMatchObject({
      direction: 'them-to-me',
      sourceLanguage: 'es',
      targetLanguage: 'en',
      transcript: '¿Dónde está la estación?',
      translation: 'Where is the station?',
    });
    expect(snapshot.currentTranscript).toBeNull(); // Transient state cleared.
    expect(snapshot.processingPhase).toBe('idle');
    controller.dispose();
  });

  it('incoming completion resumes listening after the display delay', async () => {
    vi.useFakeTimers();
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);

    client.resolveTranscription(0, 'hola');
    await vi.advanceTimersByTimeAsync(0);
    client.resolveTranslation(0, 'hello');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().status).toBe('SHOWING_THEM_RESULT');

    await vi.advanceTimersByTimeAsync(appConfig.conversation.incomingResultResumeDelayMs + 10);
    expect(controller.snapshot().status).toBe('LISTENING_TO_THEM');
    controller.dispose();
  });

  it('outgoing completion enters READ_ALOUD_PAUSED with the microphone off', async () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    controller.toggleDirection();
    expect(controller.snapshot().status).toBe('LISTENING_TO_ME');
    speak(controller);

    expect(client.transcribeCalls[0]!.sourceLanguage).toBe('en');
    client.resolveTranscription(0, 'Where is the station?');
    await flush();
    client.resolveTranslation(0, '¿Dónde está la estación?');
    await flush();

    const snapshot = controller.snapshot();
    expect(snapshot.status).toBe('READ_ALOUD_PAUSED');
    expect(snapshot.micOpen).toBe(false);
    expect(snapshot.latestTurn?.translation).toBe('¿Dónde está la estación?');

    // Audio arriving while paused is never consumed.
    controller.handleAudioFrame(pcmFrame(8000));
    expect(client.transcribeCalls).toHaveLength(1);
    controller.dispose();
  });
});

describe('live preview while speaking', () => {
  /** Enter recording and keep speaking (no closing silence). */
  function speakWithoutFinishing(controller: ConversationController, frames = 75): void {
    for (let i = 0; i < frames; i += 1) controller.handleAudioFrame(pcmFrame(8000));
  }

  it('transcribes and translates the audio-so-far every interval, then the final pass wins', async () => {
    vi.useFakeTimers();
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speakWithoutFinishing(controller); // 1.5 s of speech, still talking
    expect(client.transcribeCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(appConfig.livePreview.intervalMs);
    expect(client.transcribeCalls).toHaveLength(1); // preview pass
    client.resolveTranscription(0, 'Dónde está la');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().partialTranscript).toBe('Dónde está la');
    expect(controller.snapshot().status).toBe('LISTENING_TO_THEM'); // still live

    expect(client.translateCalls).toHaveLength(1); // preview translation
    client.resolveTranslation(0, 'Where is the');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().partialTranslation).toBe('Where is the');

    // Speaker finishes: previews stop, the authoritative final chain runs.
    const silentFrames = Math.ceil(appConfig.vad.endSilenceMs / appConfig.vad.frameMs) + 2;
    for (let i = 0; i < silentFrames; i += 1) controller.handleAudioFrame(pcmFrame(0));
    expect(client.transcribeCalls).toHaveLength(2);

    client.resolveTranscription(1, '¿Dónde está la estación?');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().currentTranscript).toBe('¿Dónde está la estación?');
    expect(controller.snapshot().partialTranscript).toBeNull(); // final replaced preview

    client.resolveTranslation(1, 'Where is the station?');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().latestTurn?.transcript).toBe('¿Dónde está la estación?');
    expect(controller.snapshot().history).toHaveLength(1); // previews never create turns
    controller.dispose();
  });

  it('keeps one preview active and queues only the newest audio snapshot', async () => {
    vi.useFakeTimers();

    const client = new MockClient();
    const controller = makeController(client);

    controller.startConversation();

    // First 1.5 seconds of continuous speech.
    speakWithoutFinishing(controller);

    // The first timer tick starts preview 1.
    await vi.advanceTimersByTimeAsync(appConfig.livePreview.intervalMs);

    expect(client.transcribeCalls).toHaveLength(1);

    // The person continues speaking while preview 1 is unresolved.
    speakWithoutFinishing(controller);

    // The next timer tick captures newer cumulative audio, but it must not
    // create a concurrent request. It is stored as the queued snapshot.
    await vi.advanceTimersByTimeAsync(appConfig.livePreview.intervalMs);

    expect(client.transcribeCalls).toHaveLength(1);

    // Complete preview 1.
    client.resolveTranscription(0, 'so far');
    await vi.advanceTimersByTimeAsync(0);

    expect(client.translateCalls).toHaveLength(1);

    client.resolveTranslation(0, 'hasta ahora');
    await vi.advanceTimersByTimeAsync(0);

    // The newest queued snapshot starts immediately. It does not wait for
    // another timer tick.
    expect(client.transcribeCalls).toHaveLength(2);

    // Continue speaking while preview 2 is unresolved.
    speakWithoutFinishing(controller);

    await vi.advanceTimersByTimeAsync(
      appConfig.livePreview.intervalMs * 3,
    );

    // Further timer ticks may replace the queued snapshot, but they must never
    // create preview 3 while preview 2 is still active.
    expect(client.transcribeCalls).toHaveLength(2);

    controller.dispose();
  });

  it('waits for the minimum audio before sending a preview', async () => {
    vi.useFakeTimers();
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speakWithoutFinishing(controller, 20); // only 400 ms of speech so far

    await vi.advanceTimersByTimeAsync(appConfig.livePreview.intervalMs);
    expect(client.transcribeCalls).toHaveLength(0);
    controller.dispose();
  });

  it('preview failures are silent and never enter the error state', async () => {
    vi.useFakeTimers();
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speakWithoutFinishing(controller);

    await vi.advanceTimersByTimeAsync(appConfig.livePreview.intervalMs);
    client.transcribeResults[0]!.reject(
      new TranslationClientError('TRANSCRIPTION_FAILED', 'preview failed', true),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.snapshot().status).toBe('LISTENING_TO_THEM');
    expect(controller.snapshot().error).toBeNull();
    expect(controller.snapshot().partialTranscript).toBeNull();
    controller.dispose();
  });

  it('a stale preview result from a superseded utterance is dropped', async () => {
    vi.useFakeTimers();
    const client = new MockClient(false); // Ignores aborts → response arrives late.
    const controller = makeController(client);
    controller.startConversation();
    speakWithoutFinishing(controller);

    await vi.advanceTimersByTimeAsync(appConfig.livePreview.intervalMs);
    expect(client.transcribeCalls).toHaveLength(1);

    controller.toggleDirection(); // Abandons the utterance and its previews.
    client.resolveTranscription(0, 'ghost preview');
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.snapshot().partialTranscript).toBeNull();
    expect(controller.snapshot().status).toBe('LISTENING_TO_ME');
    controller.dispose();
  });

  it('makes no preview requests when live preview is disabled', async () => {
    vi.useFakeTimers();
    const client = new MockClient();
    const config = {
      ...appConfig,
      livePreview: { ...appConfig.livePreview, enabled: false },
    };
    const controller = new ConversationController({
      config,
      client,
      microphone: null,
      settings: { myLanguage: 'en', otherLanguage: 'es' },
    });
    controller.startConversation();
    speakWithoutFinishing(controller);

    await vi.advanceTimersByTimeAsync(appConfig.livePreview.intervalMs * 4);
    expect(client.transcribeCalls).toHaveLength(0); // strict one-request mode

    const silentFrames = Math.ceil(appConfig.vad.endSilenceMs / appConfig.vad.frameMs) + 2;
    for (let i = 0; i < silentFrames; i += 1) controller.handleAudioFrame(pcmFrame(0));
    expect(client.transcribeCalls).toHaveLength(1); // only the final pass
    controller.dispose();
  });
});

describe('cancellation', () => {
  it('a direction toggle cancels an active transcription', () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);
    expect(client.transcribeCalls[0]!.signal?.aborted).toBe(false);

    controller.toggleDirection();
    expect(client.transcribeCalls[0]!.signal?.aborted).toBe(true);
    expect(controller.snapshot().status).toBe('LISTENING_TO_ME');
    expect(controller.snapshot().error).toBeNull(); // Cancellation is not an error.
  });

  it('a direction toggle cancels an active translation and clears the transcript', async () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);
    client.resolveTranscription(0, 'hola');
    await flush();
    expect(controller.snapshot().currentTranscript).toBe('hola');

    controller.toggleDirection();
    expect(client.translateCalls[0]!.signal?.aborted).toBe(true);
    expect(controller.snapshot().currentTranscript).toBeNull();
    await flush();
    expect(controller.snapshot().status).toBe('LISTENING_TO_ME');
    expect(controller.snapshot().history).toHaveLength(0);
    controller.dispose();
  });

  it('going offline cancels the active stage', () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);

    controller.setNetworkOnline(false);
    expect(client.transcribeCalls[0]!.signal?.aborted).toBe(true);
    expect(controller.snapshot().status).toBe('OFFLINE');
    controller.dispose();
  });

  it('ending the conversation cancels the active stage', () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);

    controller.endConversation();
    expect(client.transcribeCalls[0]!.signal?.aborted).toBe(true);
    expect(controller.snapshot().status).toBe('SETUP');
    controller.dispose();
  });

  it('exit and disposal cancel the active stage', async () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);
    client.resolveTranscription(0, 'hola');
    await flush();
    expect(client.translateCalls).toHaveLength(1);

    controller.requestExit();
    expect(client.translateCalls[0]!.signal?.aborted).toBe(true);

    const client2 = new MockClient();
    const controller2 = makeController(client2);
    controller2.startConversation();
    speak(controller2);
    controller2.dispose();
    expect(client2.transcribeCalls[0]!.signal?.aborted).toBe(true);
  });
});

describe('stale responses', () => {
  it('ignores a transcription response from a superseded chain', async () => {
    const client = new MockClient(false); // Aborts are ignored → responses arrive late.
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);

    controller.toggleDirection(); // Chain 1 superseded.
    client.resolveTranscription(0, 'stale text');
    await flush();

    const snapshot = controller.snapshot();
    expect(snapshot.currentTranscript).toBeNull();
    expect(snapshot.status).toBe('LISTENING_TO_ME');
    // The stale chain continues into translation, but its result can never win.
    controller.dispose();
  });

  it('ignores a translation response from a superseded chain', async () => {
    const client = new MockClient(false);
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);
    client.resolveTranscription(0, 'hola');
    await flush();
    expect(client.translateCalls).toHaveLength(1);

    controller.toggleDirection(); // Cancel while translating.
    client.resolveTranslation(0, 'stale translation');
    await flush();

    const snapshot = controller.snapshot();
    expect(snapshot.history).toHaveLength(0); // Never became a turn.
    expect(snapshot.status).toBe('LISTENING_TO_ME');
    controller.dispose();
  });

  it('a response from a previous utterance never overwrites the current display', async () => {
    const client = new MockClient(false);
    const controller = makeController(client);
    controller.startConversation();
    speak(controller); // Utterance 1.

    controller.toggleDirection(); // Abandon it…
    controller.snapshot();
    // Debounced toggle: wait past the debounce window before toggling back.
    await new Promise((resolve) =>
      setTimeout(resolve, appConfig.conversation.toggleDebounceMs + 50),
    );
    controller.toggleDirection(); // …and listen to them again.
    expect(controller.snapshot().status).toBe('LISTENING_TO_THEM');
    speak(controller); // Utterance 2.
    expect(client.transcribeCalls).toHaveLength(2);

    client.resolveTranscription(0, 'ANSWER FROM UTTERANCE ONE');
    await flush();
    expect(controller.snapshot().currentTranscript).toBeNull(); // Old chain ignored.

    client.resolveTranscription(1, 'respuesta actual');
    await flush();
    expect(controller.snapshot().currentTranscript).toBe('respuesta actual');

    client.resolveTranslation(client.translateCalls.length - 1, 'current answer');
    await flush();
    expect(controller.snapshot().latestTurn?.transcript).toBe('respuesta actual');
    expect(controller.snapshot().latestTurn?.translation).toBe('current answer');
    controller.dispose();
  }, 10_000);
});

describe('translation failure and retry', () => {
  async function failTranslation(client: MockClient, controller: ConversationController) {
    controller.startConversation();
    speak(controller);
    client.resolveTranscription(0, '¿Dónde está la estación?');
    await flush();
    client.translateResults[0]!.reject(
      new TranslationClientError('TRANSLATION_FAILED', 'Translation failed — try again', true),
    );
    await flush();
  }

  it('preserves the transcript when translation fails', async () => {
    const client = new MockClient();
    const controller = makeController(client);
    await failTranslation(client, controller);

    const snapshot = controller.snapshot();
    expect(snapshot.status).toBe('ERROR');
    expect(snapshot.currentTranscript).toBe('¿Dónde está la estación?');
    expect(snapshot.error?.code).toBe('TRANSLATION_FAILED');
    expect(snapshot.error?.retryable).toBe(true);
    controller.dispose();
  });

  it('retry reuses the preserved transcript instead of retranscribing', async () => {
    const client = new MockClient();
    const controller = makeController(client);
    await failTranslation(client, controller);

    controller.retry();
    await flush();
    expect(client.transcribeCalls).toHaveLength(1); // No second transcription.
    expect(client.translateCalls).toHaveLength(2);
    expect(client.translateCalls[1]!.text).toBe('¿Dónde está la estación?');

    client.resolveTranslation(1, 'Where is the station?');
    await flush();
    const snapshot = controller.snapshot();
    expect(snapshot.status).toBe('SHOWING_THEM_RESULT');
    expect(snapshot.latestTurn?.transcript).toBe('¿Dónde está la estación?');
    expect(snapshot.latestTurn?.translation).toBe('Where is the station?');
    controller.dispose();
  });

  it('transcription failure keeps the audio retry path', async () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);
    client.transcribeResults[0]!.reject(
      new TranslationClientError('TRANSCRIPTION_FAILED', 'Could not understand the audio', true),
    );
    await flush();

    expect(controller.snapshot().status).toBe('ERROR');
    expect(controller.snapshot().currentTranscript).toBeNull();

    controller.retry();
    await flush();
    expect(client.transcribeCalls).toHaveLength(2); // Full chain re-runs.
    controller.dispose();
  });
});

describe('manual typed translation', () => {
  it('translates typed text without any transcription request', async () => {
    const client = new MockClient();
    const controller = makeController(client);

    controller.submitManualText('Where is the station?', 'me-to-them');
    expect(client.transcribeCalls).toHaveLength(0);
    expect(client.translateCalls).toHaveLength(1);
    expect(client.translateCalls[0]!.text).toBe('Where is the station?');
    expect(controller.snapshot().processingPhase).toBe('translating');
    expect(controller.snapshot().currentTranscript).toBe('Where is the station?');

    client.resolveTranslation(0, '¿Dónde está la estación?');
    await flush();
    const snapshot = controller.snapshot();
    expect(snapshot.status).toBe('READ_ALOUD_PAUSED');
    expect(snapshot.latestTurn).toMatchObject({
      direction: 'me-to-them',
      transcript: 'Where is the station?',
      translation: '¿Dónde está la estación?',
    });
    controller.dispose();
  });

  it('manual them-to-me input completes as an incoming result', async () => {
    const client = new MockClient();
    const controller = makeController(client);

    controller.submitManualText('¿Dónde está la estación?', 'them-to-me');
    expect(client.translateCalls[0]!.sourceLanguage).toBe('es');
    expect(client.translateCalls[0]!.targetLanguage).toBe('en');

    client.resolveTranslation(0, 'Where is the station?');
    await flush();
    expect(controller.snapshot().status).toBe('SHOWING_THEM_RESULT');
    expect(controller.snapshot().latestTurn?.direction).toBe('them-to-me');
    controller.dispose();
  });
});

describe('language settings safety', () => {
  it('does not change languages during an active conversation', () => {
    const client = new MockClient();
    const controller = makeController(client);

    expect(controller.snapshot().settings).toEqual({
      myLanguage: 'en',
      otherLanguage: 'es',
    });

    controller.startConversation();

    controller.updateSettings({
      myLanguage: 'de',
      otherLanguage: 'fr',
    });

    // Active conversation keeps its original language pair.
    expect(controller.snapshot().settings).toEqual({
      myLanguage: 'en',
      otherLanguage: 'es',
    });

    controller.endConversation();

    controller.updateSettings({
      myLanguage: 'de',
      otherLanguage: 'fr',
    });

    // Settings may be changed after the conversation ends.
    expect(controller.snapshot().settings).toEqual({
      myLanguage: 'de',
      otherLanguage: 'fr',
    });

    controller.dispose();
  });
});