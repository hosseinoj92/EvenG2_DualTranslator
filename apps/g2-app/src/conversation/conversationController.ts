/**
 * Imperative shell around the pure conversation machine. Dispatches events,
 * executes the effects the reducer returns (mic, requests, timers, shutdown)
 * and publishes an AppSnapshot to subscribers (glasses display + phone UI)
 * after every transition.
 *
 * Spoken audio is processed in two explicit stages, one chain per utterance:
 *   1. `transcribeFinal` — exactly one transcription request per completed
 *      utterance (never partial, never periodic);
 *   2. `translateText` — runs only after the transcript is back and visible.
 * Both stages share one AbortController and one requestId, so a toggle,
 * offline transition, exit or disposal cancels whichever stage is active and
 * stale responses are dropped by the reducer's requestId check.
 */

import type { ConversationDirection, LanguageCode } from '@turntranslate/shared';
import type { AppConfig } from '../config';
import type { TranslationClient } from '../api/translationClient';
import { TranslationClientError } from '../api/apiErrors';
import type { MicrophoneController } from '../audio/audioCapture';
import { VoiceActivityDetector } from '../audio/voiceActivityDetector';
import { encodeWav } from '../audio/wavEncoder';
import type { AppSnapshot, LanguageSettings, VadDebugInfo } from '../types';
import { leadingDebounce, type LeadingDebounced } from '../utils/debounce';
import { makeId } from '../utils/ids';
import type { ConversationEffect, ConversationEvent, MachineState } from './conversationMachine';
import { conversationReducer, initialMachineState } from './conversationMachine';
import { latestTurn } from './historyStore';

export interface ControllerDeps {
  config: AppConfig;
  client: TranslationClient;
  /** Null when running outside the Even App WebView (phone-only dev mode). */
  microphone: MicrophoneController | null;
  settings: LanguageSettings;
  onSettingsChanged?: (settings: LanguageSettings) => void;
  /** Called when the machine reaches EXITING and cleanup has run. */
  onShutdown?: () => void;
}

type SnapshotListener = (snapshot: AppSnapshot) => void;

/** Everything needed to re-run translation without retranscribing the audio. */
interface FailedTranslationContext {
  transcript: string;
  direction: ConversationDirection;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
}

export class ConversationController {
  private state: MachineState;
  private settings: LanguageSettings;
  private readonly vad: VoiceActivityDetector;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly toggleDebounced: LeadingDebounced<[]>;

  private abortController: AbortController | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUtterance: Uint8Array | null = null;
  private lastFailedUtterance: Uint8Array | null = null;
  private lastFailedTranslation: FailedTranslationContext | null = null;
  private pendingManualText: string | null = null;
  private vadDebug: VadDebugInfo = { rms: 0, speaking: false, state: 'idle' };
  private lastLatencyMs: number | null = null;
  private micOpen = false;
  private disposed = false;

  constructor(private readonly deps: ControllerDeps) {
    this.state = initialMachineState(typeof navigator === 'undefined' ? true : navigator.onLine);
    this.settings = deps.settings;
    this.vad = new VoiceActivityDetector(deps.config.vad, {
      onSpeechStart: () => this.dispatch({ type: 'SPEECH_STARTED' }),
      onUtterance: (pcm) => this.handleUtterance(pcm),
      onRejected: () => {
        // Too-short blips are dropped silently; the app keeps listening.
      },
      onDebug: (info) => {
        this.vadDebug = info;
        this.emitSnapshot();
      },
    });
    this.toggleDebounced = leadingDebounce(
      () => this.dispatch({ type: 'TOGGLE_DIRECTION' }),
      deps.config.conversation.toggleDebounceMs,
    );
  }

  // ----- public API -------------------------------------------------------

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): AppSnapshot {
    const browsing =
      this.state.historyIndex !== null
        ? (this.state.history[this.state.historyIndex] ?? null)
        : null;
    return {
      status: this.state.status,
      direction: this.state.direction,
      settings: this.settings,
      conversationActive: this.state.conversationActive,
      bridgeConnected: this.deps.microphone !== null,
      online: this.state.online,
      micOpen: this.micOpen,
      speechActive: this.state.speechActive,
      processingPhase: this.state.processingPhase,
      currentTranscript: this.state.currentTranscript,
      history: [...this.state.history],
      historyIndex: this.state.historyIndex,
      latestTurn: latestTurn(this.state.history),
      browsingTurn: browsing,
      error: this.state.lastError
        ? {
            code: this.state.lastError.code,
            message: this.state.lastError.message,
            retryable: this.state.lastError.retryable,
          }
        : null,
      vad: this.vadDebug,
      lastLatencyMs: this.lastLatencyMs,
      backendUrl: this.deps.config.api.baseUrl,
    };
  }

  startConversation(): void {
    this.dispatch({ type: 'START_CONVERSATION' });
  }

  endConversation(): void {
    this.dispatch({ type: 'END_CONVERSATION' });
  }

  /** Debounced direction toggle shared by the R1 click and the phone button. */
  toggleDirection(): void {
    this.toggleDebounced();
  }

  /**
   * Glasses click. What a click means depends on the state: start in SETUP,
   * retry in ERROR, toggle everywhere else.
   */
  handleGlassesClick(): void {
    if (this.state.status === 'SETUP') {
      this.startConversation();
      return;
    }
    if (this.state.status === 'ERROR') {
      this.retry();
      return;
    }
    this.toggleDirection();
  }

  retry(): void {
    this.dispatch({ type: 'RETRY', requestId: makeId() });
  }

  historyPrevious(): void {
    this.dispatch({ type: 'HISTORY_PREVIOUS' });
  }

  historyNext(): void {
    this.dispatch({ type: 'HISTORY_NEXT' });
  }

  submitManualText(text: string, direction: ConversationDirection): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.pendingManualText = trimmed;
    this.dispatch({
      type: 'MANUAL_INPUT_SUBMITTED',
      requestId: makeId(),
      direction,
      text: trimmed,
    });
  }

  setNetworkOnline(online: boolean): void {
    this.dispatch({ type: online ? 'NETWORK_ONLINE' : 'NETWORK_OFFLINE' });
  }

  requestExit(): void {
    this.dispatch({ type: 'EXIT' });
  }

  updateSettings(settings: LanguageSettings): void {
    if (settings.myLanguage === settings.otherLanguage) return;
    this.settings = settings;
    this.deps.onSettingsChanged?.(settings);
    this.vad.reset();
    this.emitSnapshot();
  }

  swapLanguages(): void {
    this.updateSettings({
      myLanguage: this.settings.otherLanguage,
      otherLanguage: this.settings.myLanguage,
    });
  }

  /** Raw PCM from the glasses mic. Consumed only while actively listening. */
  handleAudioFrame(pcm: Uint8Array): void {
    if (this.state.status !== 'LISTENING_TO_THEM' && this.state.status !== 'LISTENING_TO_ME') {
      return; // Processing / setup / error / browsing / read-aloud: ignore audio.
    }
    this.vad.push(pcm);
  }

  /** Full teardown; used by beforeunload and system-exit events. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.toggleDebounced.cancel();
    this.cancelActiveRequest();
    this.clearResumeTimer();
    this.vad.reset();
    this.pendingUtterance = null;
    this.lastFailedUtterance = null;
    this.lastFailedTranslation = null;
    this.pendingManualText = null;
    this.listeners.clear();
  }

  // ----- machine plumbing -------------------------------------------------

  private dispatch(event: ConversationEvent): void {
    if (this.disposed) return;
    const { state, effects } = conversationReducer(this.state, event, {
      maxHistoryItems: this.deps.config.conversation.maxHistoryItems,
    });
    this.state = state;
    for (const effect of effects) {
      this.runEffect(effect);
    }
    this.emitSnapshot();
  }

  private runEffect(effect: ConversationEffect): void {
    switch (effect.type) {
      case 'SET_MIC':
        this.setMic(effect.open);
        break;
      case 'RESET_VAD':
        this.vad.reset();
        break;
      case 'CANCEL_ACTIVE_REQUEST':
        this.cancelActiveRequest();
        break;
      case 'BEGIN_REQUEST':
        if (effect.kind === 'manual') {
          this.beginManualRequest(effect.requestId);
        } else {
          this.beginUtteranceRequest(effect.requestId, this.pendingUtterance);
          this.pendingUtterance = null;
        }
        break;
      case 'RETRY_LAST_UTTERANCE':
        this.beginUtteranceRequest(effect.requestId, this.lastFailedUtterance);
        break;
      case 'RETRY_TRANSLATION':
        this.beginTranslationRetry(effect.requestId);
        break;
      case 'SCHEDULE_RESUME':
        this.clearResumeTimer();
        this.resumeTimer = setTimeout(() => {
          this.resumeTimer = null;
          this.dispatch({ type: 'RESULT_DISPLAY_ELAPSED' });
        }, this.deps.config.conversation.incomingResultResumeDelayMs);
        break;
      case 'CANCEL_RESUME':
        this.clearResumeTimer();
        break;
      case 'SHUTDOWN':
        this.shutdown();
        break;
    }
  }

  private handleUtterance(pcm: Uint8Array): void {
    this.pendingUtterance = pcm;
    this.dispatch({ type: 'UTTERANCE_COMPLETED', requestId: makeId() });
  }

  /**
   * The two-stage spoken-audio chain: encode the completed utterance as WAV,
   * transcribe it exactly once, surface the transcript, then translate it.
   * One AbortController covers both stages; the reducer's requestId check
   * drops anything arriving after the chain was superseded or cancelled.
   */
  private beginUtteranceRequest(requestId: string, pcm: Uint8Array | null): void {
    if (!pcm || pcm.length === 0) {
      this.dispatch({
        type: 'PROCESSING_FAILED',
        requestId,
        error: {
          code: 'UTTERANCE_TOO_SHORT',
          message: 'Nothing to translate — try speaking again',
          retryable: false,
          canRetryUtterance: false,
          canRetryTranslation: false,
        },
      });
      return;
    }

    const direction = this.state.direction;
    const { sourceLanguage, targetLanguage } = this.languagesFor(direction);
    const wav = encodeWav(pcm, this.deps.config.audio);
    const controller = new AbortController();
    this.abortController = controller;
    const startedAt = Date.now();

    const chain = async (): Promise<void> => {
      let transcript: string;
      try {
        const transcription = await this.deps.client.transcribeFinal({
          wav,
          sourceLanguage,
          requestId,
          signal: controller.signal,
        });
        transcript = transcription.transcript;
      } catch (error) {
        this.finishRequest(controller);
        this.handleTranscriptionFailure(requestId, error, pcm);
        return;
      }

      // The completed transcript is shown on phone + glasses immediately,
      // before the translation request is even sent.
      this.dispatch({ type: 'TRANSCRIPTION_SUCCEEDED', requestId, transcript });
      if (controller.signal.aborted) return; // Chain was cancelled mid-dispatch.

      try {
        const response = await this.deps.client.translateText({
          text: transcript,
          sourceLanguage,
          targetLanguage,
          direction,
          requestId,
          signal: controller.signal,
        });
        this.lastLatencyMs = Date.now() - startedAt;
        this.lastFailedUtterance = null;
        this.lastFailedTranslation = null;
        this.finishRequest(controller);
        this.dispatch({
          type: 'PROCESSING_SUCCEEDED',
          requestId,
          turn: {
            id: requestId,
            direction,
            sourceLanguage,
            targetLanguage,
            // The final transcription result is authoritative — not the echo
            // the translation endpoint returns.
            transcript,
            translation: response.translation,
            timestamp: Date.now(),
          },
        });
      } catch (error) {
        this.finishRequest(controller);
        this.handleTranslationFailure(requestId, error, {
          transcript,
          direction,
          sourceLanguage,
          targetLanguage,
        });
      }
    };
    void chain();
  }

  private beginManualRequest(requestId: string): void {
    const text = this.pendingManualText;
    this.pendingManualText = null;
    if (!text) return;

    const direction = this.state.direction;
    const { sourceLanguage, targetLanguage } = this.languagesFor(direction);
    this.runTranslationStage(requestId, {
      transcript: text,
      direction,
      sourceLanguage,
      targetLanguage,
    });
  }

  /** RETRY_TRANSLATION effect: reuse the preserved transcript, no re-transcription. */
  private beginTranslationRetry(requestId: string): void {
    const context = this.lastFailedTranslation;
    if (!context) {
      this.dispatch({
        type: 'PROCESSING_FAILED',
        requestId,
        error: {
          code: 'TRANSLATION_FAILED',
          message: 'Translation unavailable',
          retryable: false,
          canRetryUtterance: false,
          canRetryTranslation: false,
        },
      });
      return;
    }
    this.runTranslationStage(requestId, context);
  }

  /**
   * Translation-only request used by manual typed input and translation
   * retries. Language pair and direction come from the given context (for
   * retries this is the pair captured when the utterance was processed, not
   * the current settings).
   */
  private runTranslationStage(requestId: string, context: FailedTranslationContext): void {
    const controller = new AbortController();
    this.abortController = controller;
    const startedAt = Date.now();

    this.deps.client
      .translateText({
        text: context.transcript,
        sourceLanguage: context.sourceLanguage,
        targetLanguage: context.targetLanguage,
        direction: context.direction,
        requestId,
        signal: controller.signal,
      })
      .then((response) => {
        this.lastLatencyMs = Date.now() - startedAt;
        this.lastFailedTranslation = null;
        this.finishRequest(controller);
        this.dispatch({
          type: 'PROCESSING_SUCCEEDED',
          requestId,
          turn: {
            id: requestId,
            direction: context.direction,
            sourceLanguage: context.sourceLanguage,
            targetLanguage: context.targetLanguage,
            transcript: context.transcript,
            translation: response.translation,
            timestamp: Date.now(),
          },
        });
      })
      .catch((error: unknown) => {
        this.finishRequest(controller);
        this.handleTranslationFailure(requestId, error, context);
      });
  }

  /** Stage-1 failure: nothing was recognized, optionally keep the audio for retry. */
  private handleTranscriptionFailure(
    requestId: string,
    error: unknown,
    utterance: Uint8Array,
  ): void {
    if (error instanceof TranslationClientError && error.code === 'CANCELLED') {
      return; // Deliberate cancellation (toggle/offline/exit) — not an error state.
    }
    const clientError =
      error instanceof TranslationClientError ? error : TranslationClientError.network();

    // Keep the utterance for one retry only when a retry could plausibly work.
    const canRetryUtterance = clientError.retryable;
    this.lastFailedUtterance = canRetryUtterance ? utterance : null;
    this.lastFailedTranslation = null;

    this.dispatch({
      type: 'PROCESSING_FAILED',
      requestId,
      error: {
        code: clientError.code,
        message: clientError.userMessage,
        retryable: clientError.retryable,
        canRetryUtterance,
        canRetryTranslation: false,
      },
    });
  }

  /** Stage-2 failure: the transcript survives so a retry skips transcription. */
  private handleTranslationFailure(
    requestId: string,
    error: unknown,
    context: FailedTranslationContext,
  ): void {
    if (error instanceof TranslationClientError && error.code === 'CANCELLED') {
      return;
    }
    const clientError =
      error instanceof TranslationClientError ? error : TranslationClientError.network();

    const canRetryTranslation = clientError.retryable;
    this.lastFailedTranslation = canRetryTranslation ? context : null;
    this.lastFailedUtterance = null;

    this.dispatch({
      type: 'PROCESSING_FAILED',
      requestId,
      error: {
        code: clientError.code,
        message: clientError.userMessage,
        retryable: clientError.retryable,
        canRetryUtterance: false,
        canRetryTranslation,
      },
    });
  }

  private finishRequest(controller: AbortController): void {
    if (this.abortController === controller) {
      this.abortController = null;
    }
  }

  private cancelActiveRequest(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer !== null) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  private setMic(open: boolean): void {
    this.micOpen = open;
    const microphone = this.deps.microphone;
    if (!microphone) return;
    microphone.setOpen(open).catch(() => {
      if (!open) return;
      this.micOpen = false;
      this.dispatch({
        type: 'MIC_FAILED',
        error: {
          code: 'MIC_PERMISSION_DENIED',
          message: 'Microphone unavailable — check permissions',
          retryable: false,
          canRetryUtterance: false,
          canRetryTranslation: false,
        },
      });
    });
  }

  private shutdown(): void {
    this.setMic(false);
    this.deps.onShutdown?.();
  }

  private languagesFor(direction: ConversationDirection): {
    sourceLanguage: LanguageCode;
    targetLanguage: LanguageCode;
  } {
    return direction === 'them-to-me'
      ? { sourceLanguage: this.settings.otherLanguage, targetLanguage: this.settings.myLanguage }
      : { sourceLanguage: this.settings.myLanguage, targetLanguage: this.settings.otherLanguage };
  }

  private emitSnapshot(): void {
    if (this.disposed) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
