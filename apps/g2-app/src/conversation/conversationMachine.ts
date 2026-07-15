/**
 * The conversation workflow as a pure, typed finite state machine.
 *
 * `conversationReducer(state, event)` returns the next state plus a list of
 * effects for the controller to execute (mic control, request start/cancel,
 * timers, shutdown). The reducer itself performs no I/O, generates no IDs and
 * reads no clocks, which is what makes every transition unit-testable.
 *
 * Invariants encoded here:
 *   - at most one voice-processing chain exists at a time (`activeRequestId`);
 *   - stale TRANSCRIPTION_SUCCEEDED / PROCESSING_* results (mismatched
 *     requestId) are ignored;
 *   - audio is only consumed in the two LISTENING_* states (the controller
 *     additionally drops PCM frames in every other state);
 *   - a toggle during an active request cancels it (CANCEL_ACTIVE_REQUEST →
 *     AbortController in the controller);
 *   - the transient transcript survives from transcription success through
 *     translation success or failure, and is cleared on every path that
 *     abandons the utterance (new utterance, toggle, end, offline, exit).
 */

import type { ConversationDirection } from '@turntranslate/shared';
import type { ConversationTurn } from '../types';
import { appendTurn, nextIndex, previousIndex, startBrowsingIndex } from './historyStore';

export type ConversationStatus =
  | 'SETUP'
  | 'LISTENING_TO_THEM'
  | 'PROCESSING_THEM'
  | 'SHOWING_THEM_RESULT'
  | 'LISTENING_TO_ME'
  | 'PROCESSING_ME'
  | 'READ_ALOUD_PAUSED'
  | 'BROWSING_HISTORY'
  | 'OFFLINE'
  | 'ERROR'
  | 'EXITING';

/**
 * Which stage of the two-stage pipeline (final transcription → translation)
 * is currently running. `translating` is also used for manual typed input,
 * which skips the transcription stage.
 */
export type ProcessingPhase = 'idle' | 'transcribing' | 'translating';

export interface MachineErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  /** True when the controller still holds the failed utterance for a re-send. */
  canRetryUtterance: boolean;
  /**
   * True when transcription succeeded but translation failed: the controller
   * holds the completed transcript, so a retry can re-run translation only
   * instead of retranscribing the audio.
   */
  canRetryTranslation: boolean;
}

export type ConversationEvent =
  | { type: 'START_CONVERSATION' }
  | { type: 'END_CONVERSATION' }
  | { type: 'TOGGLE_DIRECTION' }
  | { type: 'SPEECH_STARTED' }
  | { type: 'UTTERANCE_COMPLETED'; requestId: string }
  | {
      type: 'MANUAL_INPUT_SUBMITTED';
      requestId: string;
      direction: ConversationDirection;
      text: string;
    }
  | { type: 'PARTIAL_TRANSCRIPT'; transcript: string }
  | { type: 'PARTIAL_TRANSLATION'; translation: string }
  | { type: 'TRANSCRIPTION_SUCCEEDED'; requestId: string; transcript: string }
  | { type: 'PROCESSING_SUCCEEDED'; requestId: string; turn: ConversationTurn }
  | { type: 'PROCESSING_FAILED'; requestId: string; error: MachineErrorInfo }
  | { type: 'RESULT_DISPLAY_ELAPSED' }
  | { type: 'RETRY'; requestId: string }
  | { type: 'HISTORY_PREVIOUS' }
  | { type: 'HISTORY_NEXT' }
  | { type: 'NETWORK_OFFLINE' }
  | { type: 'NETWORK_ONLINE' }
  | { type: 'MIC_FAILED'; error: MachineErrorInfo }
  | { type: 'EXIT' };

export type ConversationEffect =
  | { type: 'SET_MIC'; open: boolean }
  | { type: 'RESET_VAD' }
  | { type: 'BEGIN_REQUEST'; requestId: string; kind: 'utterance' | 'manual' }
  | { type: 'RETRY_LAST_UTTERANCE'; requestId: string }
  | { type: 'RETRY_TRANSLATION'; requestId: string }
  | { type: 'CANCEL_ACTIVE_REQUEST' }
  | { type: 'SCHEDULE_RESUME' }
  | { type: 'CANCEL_RESUME' }
  | { type: 'SHUTDOWN' };

export interface MachineState {
  status: ConversationStatus;
  direction: ConversationDirection;
  conversationActive: boolean;
  online: boolean;
  activeRequestId: string | null;
  /** Stage of the active voice chain; `idle` outside PROCESSING_* states. */
  processingPhase: ProcessingPhase;
  /**
   * Completed transcript of the utterance currently being processed. Set when
   * transcription succeeds, kept through translation (and translation
   * failure, so the user can see what was recognized), cleared when the turn
   * completes or the utterance is abandoned.
   */
  currentTranscript: string | null;
  /**
   * Live preview of the utterance still being spoken: what has been said so
   * far, transcribed (and translated) every preview interval. Best-effort —
   * replaced by the authoritative final transcript when the utterance
   * completes, and cleared on every path that abandons the utterance.
   */
  partialTranscript: string | null;
  partialTranslation: string | null;
  history: ConversationTurn[];
  /** Index into history while BROWSING_HISTORY; null otherwise. */
  historyIndex: number | null;
  /** Where to return when browsing ends. */
  browsingReturnStatus: ConversationStatus | null;
  speechActive: boolean;
  lastError: MachineErrorInfo | null;
}

export interface MachineConfig {
  maxHistoryItems: number;
}

export interface TransitionResult {
  state: MachineState;
  effects: ConversationEffect[];
}

export function initialMachineState(online: boolean): MachineState {
  return {
    status: 'SETUP',
    direction: 'them-to-me',
    conversationActive: false,
    online,
    activeRequestId: null,
    processingPhase: 'idle',
    currentTranscript: null,
    partialTranscript: null,
    partialTranslation: null,
    history: [],
    historyIndex: null,
    browsingReturnStatus: null,
    speechActive: false,
    lastError: null,
  };
}

const micOpenIn = (status: ConversationStatus): boolean =>
  status === 'LISTENING_TO_THEM' || status === 'LISTENING_TO_ME';

const listeningStatusFor = (direction: ConversationDirection): ConversationStatus =>
  direction === 'them-to-me' ? 'LISTENING_TO_THEM' : 'LISTENING_TO_ME';

const processingStatusFor = (direction: ConversationDirection): ConversationStatus =>
  direction === 'them-to-me' ? 'PROCESSING_THEM' : 'PROCESSING_ME';

export function conversationReducer(
  state: MachineState,
  event: ConversationEvent,
  config: MachineConfig,
): TransitionResult {
  const result = reduce(state, event, config);
  return withMicEffect(state, result);
}

/**
 * Adds SET_MIC when the target state's microphone requirement changed.
 * Transitions that already emit an explicit SET_MIC (the hard-off safety in
 * EXIT/NETWORK_OFFLINE) are left untouched.
 */
function withMicEffect(previous: MachineState, result: TransitionResult): TransitionResult {
  if (result.effects.some((effect) => effect.type === 'SET_MIC')) return result;
  const before = micOpenIn(previous.status);
  const after = micOpenIn(result.state.status);
  if (before === after) return result;
  return { state: result.state, effects: [...result.effects, { type: 'SET_MIC', open: after }] };
}

function reduce(
  state: MachineState,
  event: ConversationEvent,
  config: MachineConfig,
): TransitionResult {
  if (state.status === 'EXITING') {
    return { state, effects: [] };
  }

  // Global events first: they behave identically from (almost) every state.
  switch (event.type) {
    case 'EXIT':
      return {
        state: {
          ...state,
          status: 'EXITING',
          activeRequestId: null,
          processingPhase: 'idle',
          currentTranscript: null,
          partialTranscript: null,
          partialTranslation: null,
          historyIndex: null,
          browsingReturnStatus: null,
          speechActive: false,
        },
        effects: [
          ...(state.activeRequestId ? cancelRequest() : []),
          { type: 'CANCEL_RESUME' },
          { type: 'RESET_VAD' },
          // Unconditional hard-off: never leave the mic streaming into an
          // app that is going away, whatever state it was in.
          { type: 'SET_MIC', open: false },
          { type: 'SHUTDOWN' },
        ],
      };

    case 'NETWORK_OFFLINE':
      return {
        state: {
          ...state,
          status: 'OFFLINE',
          online: false,
          activeRequestId: null,
          processingPhase: 'idle',
          currentTranscript: null,
          partialTranscript: null,
          partialTranslation: null,
          historyIndex: null,
          browsingReturnStatus: null,
          speechActive: false,
        },
        effects: [
          ...(state.activeRequestId ? cancelRequest() : []),
          { type: 'CANCEL_RESUME' },
          { type: 'RESET_VAD' },
          // No requests can be sent offline, so the mic must not keep running.
          { type: 'SET_MIC', open: false },
        ],
      };

    case 'NETWORK_ONLINE': {
      if (state.status !== 'OFFLINE') {
        return { state: { ...state, online: true }, effects: [] };
      }
      const status = state.conversationActive ? listeningStatusFor(state.direction) : 'SETUP';
      return {
        state: { ...state, status, online: true, lastError: null },
        effects: [{ type: 'RESET_VAD' }],
      };
    }

    case 'END_CONVERSATION':
      if (state.status === 'OFFLINE') {
        // Stay offline; just drop the active conversation.
        return { state: { ...state, conversationActive: false }, effects: [] };
      }
      return {
        state: {
          ...state,
          status: 'SETUP',
          conversationActive: false,
          activeRequestId: null,
          processingPhase: 'idle',
          currentTranscript: null,
          partialTranscript: null,
          partialTranslation: null,
          historyIndex: null,
          browsingReturnStatus: null,
          speechActive: false,
          lastError: null,
        },
        effects: [
          ...(state.activeRequestId ? cancelRequest() : []),
          { type: 'CANCEL_RESUME' },
          { type: 'RESET_VAD' },
        ],
      };

    case 'MIC_FAILED':
      // The microphone could not be opened: listening is impossible, so this
      // is a global hard error regardless of the current state.
      return {
        state: {
          ...state,
          status: 'ERROR',
          activeRequestId: null,
          processingPhase: 'idle',
          currentTranscript: null,
          partialTranscript: null,
          partialTranslation: null,
          historyIndex: null,
          browsingReturnStatus: null,
          speechActive: false,
          lastError: event.error,
        },
        effects: [
          ...(state.activeRequestId ? cancelRequest() : []),
          { type: 'CANCEL_RESUME' },
          { type: 'RESET_VAD' },
        ],
      };

    case 'MANUAL_INPUT_SUBMITTED':
      return handleManualInput(state, event);

    default:
      break;
  }

  switch (state.status) {
    case 'SETUP':
      return reduceSetup(state, event);
    case 'LISTENING_TO_THEM':
    case 'LISTENING_TO_ME':
      return reduceListening(state, event);
    case 'PROCESSING_THEM':
    case 'PROCESSING_ME':
      return reduceProcessing(state, event, config);
    case 'SHOWING_THEM_RESULT':
      return reduceShowingResult(state, event);
    case 'READ_ALOUD_PAUSED':
      return reduceReadAloud(state, event);
    case 'BROWSING_HISTORY':
      return reduceBrowsing(state, event);
    case 'OFFLINE':
      return { state, effects: [] };
    case 'ERROR':
      return reduceError(state, event);
  }
}

function reduceSetup(state: MachineState, event: ConversationEvent): TransitionResult {
  switch (event.type) {
    case 'START_CONVERSATION':
      return {
        state: {
          ...state,
          status: 'LISTENING_TO_THEM',
          direction: 'them-to-me',
          conversationActive: true,
          lastError: null,
          speechActive: false,
        },
        effects: [{ type: 'RESET_VAD' }],
      };
    case 'HISTORY_PREVIOUS':
      return enterBrowsing(state);
    default:
      return { state, effects: [] };
  }
}

function reduceListening(state: MachineState, event: ConversationEvent): TransitionResult {
  switch (event.type) {
    case 'SPEECH_STARTED':
      // A new utterance begins: any leftover transient text is stale.
      return {
        state: {
          ...state,
          speechActive: true,
          currentTranscript: null,
          partialTranscript: null,
          partialTranslation: null,
        },
        effects: [],
      };

    case 'PARTIAL_TRANSCRIPT':
      // Whisper can revise earlier words when more audio becomes available.
      // Never show a translation produced for an older transcript underneath
      // the new transcript.
      if (!state.speechActive) return { state, effects: [] };

      return {
        state: {
          ...state,
          partialTranscript: event.transcript,
          partialTranslation: null,
        },
        effects: [],
      };

    case 'PARTIAL_TRANSLATION':
      if (!state.speechActive || state.partialTranscript === null) {
        return { state, effects: [] };
      }
      return { state: { ...state, partialTranslation: event.translation }, effects: [] };

    case 'UTTERANCE_COMPLETED':
      return {
        state: {
          ...state,
          status: processingStatusFor(state.direction),
          activeRequestId: event.requestId,
          processingPhase: 'transcribing',
          currentTranscript: null,
          speechActive: false,
        },
        effects: [{ type: 'BEGIN_REQUEST', requestId: event.requestId, kind: 'utterance' }],
      };

    case 'TOGGLE_DIRECTION':
      return toggleFromLive(state);

    case 'HISTORY_PREVIOUS':
      return enterBrowsing(state);

    default:
      return { state, effects: [] };
  }
}

function reduceProcessing(
  state: MachineState,
  event: ConversationEvent,
  config: MachineConfig,
): TransitionResult {
  switch (event.type) {
    case 'TRANSCRIPTION_SUCCEEDED': {
      if (event.requestId !== state.activeRequestId) {
        return { state, effects: [] }; // Stale transcript: ignore entirely.
      }
      // The completed transcript becomes visible immediately (replacing any
      // live preview); the controller continues with the translation request.
      return {
        state: {
          ...state,
          processingPhase: 'translating',
          currentTranscript: event.transcript,
          partialTranscript: null,
          partialTranslation: null,
        },
        effects: [],
      };
    }

    case 'PROCESSING_SUCCEEDED': {
      if (event.requestId !== state.activeRequestId) {
        return { state, effects: [] }; // Stale response: ignore entirely.
      }
      const history = appendTurn(state.history, event.turn, config.maxHistoryItems);
      if (state.status === 'PROCESSING_ME') {
        return {
          state: {
            ...state,
            status: 'READ_ALOUD_PAUSED',
            history,
            activeRequestId: null,
            processingPhase: 'idle',
            currentTranscript: null,
            partialTranscript: null,
            partialTranslation: null,
            lastError: null,
          },
          effects: [],
        };
      }
      return {
        state: {
          ...state,
          status: 'SHOWING_THEM_RESULT',
          history,
          activeRequestId: null,
          processingPhase: 'idle',
          currentTranscript: null,
          partialTranscript: null,
          partialTranslation: null,
          lastError: null,
        },
        effects: [{ type: 'SCHEDULE_RESUME' }],
      };
    }

    case 'PROCESSING_FAILED': {
      if (event.requestId !== state.activeRequestId) {
        return { state, effects: [] }; // Stale failure: ignore.
      }
      // currentTranscript is deliberately preserved: when translation failed
      // after a successful transcription, the error display shows what was
      // recognized and a retry can reuse it. Live previews are dropped.
      return {
        state: {
          ...state,
          status: 'ERROR',
          activeRequestId: null,
          processingPhase: 'idle',
          partialTranscript: null,
          partialTranslation: null,
          lastError: event.error,
        },
        effects: [],
      };
    }

    case 'TOGGLE_DIRECTION': {
      // Toggling while a chain is in flight cancels it and drops its transcript.
      const toggled = toggleFromLive({ ...state, activeRequestId: null });
      return { state: toggled.state, effects: [...cancelRequest(), ...toggled.effects] };
    }

    default:
      return { state, effects: [] };
  }
}

function reduceShowingResult(state: MachineState, event: ConversationEvent): TransitionResult {
  switch (event.type) {
    case 'RESULT_DISPLAY_ELAPSED':
      return {
        state: {
          ...state,
          status: state.conversationActive ? 'LISTENING_TO_THEM' : 'SETUP',
          direction: 'them-to-me',
        },
        effects: [{ type: 'RESET_VAD' }],
      };

    case 'TOGGLE_DIRECTION': {
      const toggled = toggleFromLive(state);
      return { state: toggled.state, effects: [{ type: 'CANCEL_RESUME' }, ...toggled.effects] };
    }

    case 'HISTORY_PREVIOUS': {
      const browsing = enterBrowsing(state);
      return {
        state: browsing.state,
        effects: [{ type: 'CANCEL_RESUME' }, ...browsing.effects],
      };
    }

    default:
      return { state, effects: [] };
  }
}

function reduceReadAloud(state: MachineState, event: ConversationEvent): TransitionResult {
  switch (event.type) {
    case 'TOGGLE_DIRECTION':
      // Done reading aloud → go back to listening to them.
      return {
        state: {
          ...state,
          status: state.conversationActive ? 'LISTENING_TO_THEM' : 'SETUP',
          direction: 'them-to-me',
          lastError: null,
        },
        effects: [{ type: 'RESET_VAD' }],
      };

    case 'HISTORY_PREVIOUS':
      return enterBrowsing(state);

    default:
      return { state, effects: [] };
  }
}

function reduceBrowsing(state: MachineState, event: ConversationEvent): TransitionResult {
  const index = state.historyIndex;
  switch (event.type) {
    case 'HISTORY_PREVIOUS':
      if (index === null) return { state, effects: [] };
      return { state: { ...state, historyIndex: previousIndex(index) }, effects: [] };

    case 'HISTORY_NEXT': {
      if (index === null) return { state, effects: [] };
      const next = nextIndex(index, state.history.length);
      if (next !== null) {
        return { state: { ...state, historyIndex: next }, effects: [] };
      }
      return exitBrowsing(state); // Past the newest item → back to live.
    }

    case 'TOGGLE_DIRECTION':
      return exitBrowsing(state);

    default:
      return { state, effects: [] };
  }
}

function reduceError(state: MachineState, event: ConversationEvent): TransitionResult {
  switch (event.type) {
    case 'RETRY': {
      const retryable = state.lastError?.retryable === true;
      // Prefer re-running translation with the preserved transcript over
      // retranscribing the audio: cheaper and the transcript is authoritative.
      if (retryable && state.lastError?.canRetryTranslation && state.currentTranscript !== null) {
        return {
          state: {
            ...state,
            status: processingStatusFor(state.direction),
            activeRequestId: event.requestId,
            processingPhase: 'translating',
            lastError: null,
          },
          effects: [{ type: 'RETRY_TRANSLATION', requestId: event.requestId }],
        };
      }
      if (retryable && state.lastError?.canRetryUtterance) {
        return {
          state: {
            ...state,
            status: processingStatusFor(state.direction),
            activeRequestId: event.requestId,
            processingPhase: 'transcribing',
            currentTranscript: null,
            lastError: null,
          },
          effects: [{ type: 'RETRY_LAST_UTTERANCE', requestId: event.requestId }],
        };
      }
      return {
        state: {
          ...state,
          status: state.conversationActive ? listeningStatusFor(state.direction) : 'SETUP',
          currentTranscript: null,
          lastError: null,
        },
        effects: [{ type: 'RESET_VAD' }],
      };
    }

    case 'TOGGLE_DIRECTION':
      // Escape hatch: leave the error and listen to the other person.
      return {
        state: {
          ...state,
          status: state.conversationActive ? 'LISTENING_TO_THEM' : 'SETUP',
          direction: 'them-to-me',
          currentTranscript: null,
          lastError: null,
        },
        effects: [{ type: 'RESET_VAD' }],
      };

    case 'HISTORY_PREVIOUS':
      return enterBrowsing(state);

    default:
      return { state, effects: [] };
  }
}

function handleManualInput(
  state: MachineState,
  event: Extract<ConversationEvent, { type: 'MANUAL_INPUT_SUBMITTED' }>,
): TransitionResult {
  // Manual translation is allowed from every idle state, but never while
  // another request is running, never offline, and never mid-exit.
  const busy =
    state.status === 'PROCESSING_THEM' ||
    state.status === 'PROCESSING_ME' ||
    state.status === 'OFFLINE' ||
    state.status === 'EXITING';
  if (busy || state.activeRequestId !== null) {
    return { state, effects: [] };
  }
  return {
    state: {
      ...state,
      status: processingStatusFor(event.direction),
      direction: event.direction,
      activeRequestId: event.requestId,
      // Manual input skips transcription: the typed text is the transcript.
      processingPhase: 'translating',
      currentTranscript: event.text,
      partialTranscript: null,
      partialTranslation: null,
      historyIndex: null,
      browsingReturnStatus: null,
      speechActive: false,
      lastError: null,
    },
    effects: [
      { type: 'CANCEL_RESUME' },
      { type: 'RESET_VAD' },
      { type: 'BEGIN_REQUEST', requestId: event.requestId, kind: 'manual' },
    ],
  };
}

function toggleFromLive(state: MachineState): TransitionResult {
  // From an incoming state → listen to me; from outgoing/read-aloud → back to them.
  const next: ConversationDirection =
    state.direction === 'them-to-me' ? 'me-to-them' : 'them-to-me';
  return {
    state: {
      ...state,
      status: listeningStatusFor(next),
      direction: next,
      processingPhase: 'idle',
      currentTranscript: null,
      partialTranscript: null,
      partialTranslation: null,
      speechActive: false,
      lastError: null,
    },
    effects: [{ type: 'RESET_VAD' }],
  };
}

function enterBrowsing(state: MachineState): TransitionResult {
  const index = startBrowsingIndex(state.history);
  if (index === null) {
    return { state, effects: [] }; // Nothing to browse.
  }
  // SHOWING_THEM_RESULT is timer-driven; its resume timer is cancelled when
  // browsing starts, so returning there would strand the app. Normalize the
  // return target to the state the timer would have produced.
  const returnStatus: ConversationStatus =
    state.status === 'SHOWING_THEM_RESULT'
      ? state.conversationActive
        ? 'LISTENING_TO_THEM'
        : 'SETUP'
      : state.status;
  return {
    state: {
      ...state,
      status: 'BROWSING_HISTORY',
      historyIndex: index,
      browsingReturnStatus: returnStatus,
      speechActive: false,
      // Any in-flight utterance preview dies with the VAD reset.
      partialTranscript: null,
      partialTranslation: null,
    },
    effects: [{ type: 'RESET_VAD' }],
  };
}

function exitBrowsing(state: MachineState): TransitionResult {
  const returnStatus = state.browsingReturnStatus ?? 'SETUP';
  return {
    state: {
      ...state,
      status: returnStatus,
      historyIndex: null,
      browsingReturnStatus: null,
    },
    effects: [{ type: 'RESET_VAD' }],
  };
}

function cancelRequest(): ConversationEffect[] {
  return [{ type: 'CANCEL_ACTIVE_REQUEST' }];
}
