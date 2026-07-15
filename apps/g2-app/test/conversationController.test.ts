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

  it('the incoming result remains indefinitely: no timer ever resumes listening', async () => {
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

    // Far beyond any of the old 6/20/30-second delays: nothing changes and
    // the microphone stays closed.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(controller.snapshot().status).toBe('SHOWING_THEM_RESULT');
    expect(controller.snapshot().micOpen).toBe(false);
    controller.dispose();
  });

  it('R1 from the incoming result switches to LISTENING_TO_ME', async () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speak(controller);
    client.resolveTranscription(0, 'hola');
    await flush();
    client.resolveTranslation(0, 'hello');
    await flush();
    expect(controller.snapshot().status).toBe('SHOWING_THEM_RESULT');

    controller.toggleDirection();
    expect(controller.snapshot().status).toBe('LISTENING_TO_ME');
    expect(controller.snapshot().micOpen).toBe(true);
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

  it('the outgoing result remains indefinitely; R1 returns to LISTENING_TO_THEM', async () => {
    vi.useFakeTimers();
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    controller.toggleDirection();
    speak(controller);
    client.resolveTranscription(0, 'Where is the station?');
    await vi.advanceTimersByTimeAsync(0);
    client.resolveTranslation(0, '¿Dónde está la estación?');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().status).toBe('READ_ALOUD_PAUSED');

    // No timer of any kind moves the app on; the mic stays closed.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(controller.snapshot().status).toBe('READ_ALOUD_PAUSED');
    expect(controller.snapshot().micOpen).toBe(false);

    controller.toggleDirection();
    expect(controller.snapshot().status).toBe('LISTENING_TO_THEM');
    expect(controller.snapshot().micOpen).toBe(true);
    controller.dispose();
  });
});

describe('no requests while speech is still active', () => {
  /** Enter recording and keep speaking (no closing silence). */
  function speakWithoutFinishing(controller: ConversationController, frames = 75): void {
    for (let i = 0; i < frames; i += 1) controller.handleAudioFrame(pcmFrame(8000));
  }

  it('sends no transcription and no translation while the speaker is still talking', async () => {
    vi.useFakeTimers();
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speakWithoutFinishing(controller);
    expect(controller.snapshot().speechActive).toBe(true);

    // No interval, snapshot timer or preview pass exists: however long the
    // speech goes on, no request of any kind is made.
    for (let i = 0; i < 8; i += 1) {
      await vi.advanceTimersByTimeAsync(1_500);
      speakWithoutFinishing(controller);
    }
    expect(client.transcribeCalls).toHaveLength(0);
    expect(client.translateCalls).toHaveLength(0);
    expect(client.interpretCalls).toHaveLength(0);

    // Only the completed utterance triggers the single final transcription.
    const silentFrames = Math.ceil(appConfig.vad.endSilenceMs / appConfig.vad.frameMs) + 2;
    for (let i = 0; i < silentFrames; i += 1) controller.handleAudioFrame(pcmFrame(0));
    expect(client.transcribeCalls).toHaveLength(1);
    expect(client.translateCalls).toHaveLength(0); // Not until the transcript is back.
    controller.dispose();
  });

  it('snapshots expose no partial transcript or translation fields', () => {
    const client = new MockClient();
    const controller = makeController(client);
    controller.startConversation();
    speakWithoutFinishing(controller);

    const snapshot = controller.snapshot();
    expect('partialTranscript' in snapshot).toBe(false);
    expect('partialTranslation' in snapshot).toBe(false);
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

describe('full German↔English conversation (integration)', () => {
  const GERMAN_SOURCE = 'ich habe gestern mit meinem Onkel über deine Klausur gesprochen!';
  const GERMAN_TRANSLATION = 'Yesterday I talked to my uncle about your exam!';
  const ENGLISH_SOURCE = 'Yeah, to be honest, I did a very bad job on the exam!';
  const ENGLISH_TRANSLATION =
    'Ja, ehrlich gesagt habe ich bei der Klausur sehr schlecht abgeschnitten!';

  it('runs both directions strictly sequentially with one chain per utterance', async () => {
    const client = new MockClient();
    const controller = new ConversationController({
      config: appConfig,
      client,
      microphone: null,
      settings: { myLanguage: 'en', otherLanguage: 'de' },
    });
    controller.startConversation();

    // --- The other person speaks German. -----------------------------------
    speak(controller);
    expect(controller.snapshot().status).toBe('PROCESSING_THEM');
    expect(controller.snapshot().processingPhase).toBe('transcribing');
    expect(client.transcribeCalls).toHaveLength(1);
    expect(client.transcribeCalls[0]!.sourceLanguage).toBe('de');

    client.resolveTranscription(0, GERMAN_SOURCE);
    await flush();
    expect(controller.snapshot().currentTranscript).toBe(GERMAN_SOURCE);
    expect(controller.snapshot().processingPhase).toBe('translating');
    expect(client.translateCalls).toHaveLength(1);
    expect(client.translateCalls[0]!.text).toBe(GERMAN_SOURCE);

    client.resolveTranslation(0, GERMAN_TRANSLATION);
    await flush();
    const incoming = controller.snapshot();
    expect(incoming.status).toBe('SHOWING_THEM_RESULT');
    expect(incoming.latestTurn?.transcript).toBe(GERMAN_SOURCE);
    expect(incoming.latestTurn?.translation).toBe(GERMAN_TRANSLATION);
    expect(incoming.micOpen).toBe(false);

    // --- R1: my turn, I speak English. --------------------------------------
    controller.toggleDirection();
    expect(controller.snapshot().status).toBe('LISTENING_TO_ME');

    speak(controller);
    expect(client.transcribeCalls).toHaveLength(2);
    expect(client.transcribeCalls[1]!.sourceLanguage).toBe('en');

    client.resolveTranscription(1, ENGLISH_SOURCE);
    await flush();
    expect(client.translateCalls).toHaveLength(2);
    expect(client.translateCalls[1]!.text).toBe(ENGLISH_SOURCE);

    client.resolveTranslation(1, ENGLISH_TRANSLATION);
    await flush();
    const outgoing = controller.snapshot();
    expect(outgoing.status).toBe('READ_ALOUD_PAUSED');
    expect(outgoing.latestTurn?.transcript).toBe(ENGLISH_SOURCE);
    expect(outgoing.latestTurn?.translation).toBe(ENGLISH_TRANSLATION);
    expect(outgoing.micOpen).toBe(false);
    expect(outgoing.history).toHaveLength(2);

    // --- R1: back to listening to them. --------------------------------------
    await new Promise((resolve) =>
      setTimeout(resolve, appConfig.conversation.toggleDebounceMs + 50),
    );
    controller.toggleDirection();
    expect(controller.snapshot().status).toBe('LISTENING_TO_THEM');
    expect(controller.snapshot().micOpen).toBe(true);

    // Exactly one transcription and one translation per utterance, ever.
    expect(client.transcribeCalls).toHaveLength(2);
    expect(client.translateCalls).toHaveLength(2);
    expect(client.interpretCalls).toHaveLength(0);
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
