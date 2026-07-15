import { describe, expect, it } from 'vitest';
import type { ConversationEvent, MachineState } from '../src/conversation/conversationMachine';
import { conversationReducer, initialMachineState } from '../src/conversation/conversationMachine';
import type { ConversationTurn } from '../src/types';

const config = { maxHistoryItems: 20 };

function reduce(state: MachineState, event: ConversationEvent) {
  return conversationReducer(state, event, config);
}

function run(events: ConversationEvent[], from?: MachineState): MachineState {
  let state = from ?? initialMachineState(true);
  for (const event of events) {
    state = reduce(state, event).state;
  }
  return state;
}

function makeTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: 'turn-1',
    direction: 'them-to-me',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    transcript: '¿Dónde está la estación?',
    translation: 'Where is the station?',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('conversation start and direction toggling', () => {
  it('starts in SETUP and enters LISTENING_TO_THEM on START_CONVERSATION', () => {
    const initial = initialMachineState(true);
    expect(initial.status).toBe('SETUP');

    const { state, effects } = reduce(initial, { type: 'START_CONVERSATION' });
    expect(state.status).toBe('LISTENING_TO_THEM');
    expect(state.direction).toBe('them-to-me');
    expect(state.conversationActive).toBe(true);
    expect(effects).toContainEqual({ type: 'SET_MIC', open: true });
    expect(effects).toContainEqual({ type: 'RESET_VAD' });
  });

  it('toggles from incoming to LISTENING_TO_ME and back', () => {
    const listening = run([{ type: 'START_CONVERSATION' }]);
    const toMe = reduce(listening, { type: 'TOGGLE_DIRECTION' });
    expect(toMe.state.status).toBe('LISTENING_TO_ME');
    expect(toMe.state.direction).toBe('me-to-them');
    expect(toMe.effects).toContainEqual({ type: 'RESET_VAD' });

    const backToThem = reduce(toMe.state, { type: 'TOGGLE_DIRECTION' });
    expect(backToThem.state.status).toBe('LISTENING_TO_THEM');
    expect(backToThem.state.direction).toBe('them-to-me');
  });

  it('returns to LISTENING_TO_THEM when toggling out of READ_ALOUD_PAUSED', () => {
    const state = run([
      { type: 'START_CONVERSATION' },
      { type: 'TOGGLE_DIRECTION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'r1' },
      {
        type: 'PROCESSING_SUCCEEDED',
        requestId: 'r1',
        turn: makeTurn({ direction: 'me-to-them' }),
      },
    ]);
    expect(state.status).toBe('READ_ALOUD_PAUSED');

    const { state: next, effects } = reduce(state, { type: 'TOGGLE_DIRECTION' });
    expect(next.status).toBe('LISTENING_TO_THEM');
    expect(next.direction).toBe('them-to-me');
    expect(effects).toContainEqual({ type: 'SET_MIC', open: true });
  });

  it('ignores TOGGLE_DIRECTION in SETUP', () => {
    const initial = initialMachineState(true);
    const { state } = reduce(initial, { type: 'TOGGLE_DIRECTION' });
    expect(state.status).toBe('SETUP');
  });
});

describe('utterance processing', () => {
  it('moves to PROCESSING_THEM with a BEGIN_REQUEST effect and closes the mic', () => {
    const listening = run([{ type: 'START_CONVERSATION' }]);
    const { state, effects } = reduce(listening, {
      type: 'UTTERANCE_COMPLETED',
      requestId: 'req-1',
    });
    expect(state.status).toBe('PROCESSING_THEM');
    expect(state.activeRequestId).toBe('req-1');
    expect(effects).toContainEqual({
      type: 'BEGIN_REQUEST',
      requestId: 'req-1',
      kind: 'utterance',
    });
    expect(effects).toContainEqual({ type: 'SET_MIC', open: false });
  });

  it('PROCESSING_THEM success shows the result and schedules the resume', () => {
    const processing = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'req-1' },
    ]);
    const { state, effects } = reduce(processing, {
      type: 'PROCESSING_SUCCEEDED',
      requestId: 'req-1',
      turn: makeTurn(),
    });
    expect(state.status).toBe('SHOWING_THEM_RESULT');
    expect(state.history).toHaveLength(1);
    expect(state.activeRequestId).toBeNull();
    expect(effects).toContainEqual({ type: 'SCHEDULE_RESUME' });
  });

  it('resumes LISTENING_TO_THEM after the result display elapses', () => {
    const showing = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'req-1' },
      { type: 'PROCESSING_SUCCEEDED', requestId: 'req-1', turn: makeTurn() },
    ]);
    const { state, effects } = reduce(showing, { type: 'RESULT_DISPLAY_ELAPSED' });
    expect(state.status).toBe('LISTENING_TO_THEM');
    expect(effects).toContainEqual({ type: 'SET_MIC', open: true });
  });

  it('PROCESSING_ME success enters READ_ALOUD_PAUSED with the mic closed', () => {
    const state = run([
      { type: 'START_CONVERSATION' },
      { type: 'TOGGLE_DIRECTION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'req-2' },
    ]);
    expect(state.status).toBe('PROCESSING_ME');

    const { state: done, effects } = reduce(state, {
      type: 'PROCESSING_SUCCEEDED',
      requestId: 'req-2',
      turn: makeTurn({ direction: 'me-to-them' }),
    });
    expect(done.status).toBe('READ_ALOUD_PAUSED');
    // Mic stays closed: no SET_MIC open effect on this transition.
    expect(effects).not.toContainEqual({ type: 'SET_MIC', open: true });
  });

  it('rejects stale PROCESSING results by requestId', () => {
    const processing = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'req-current' },
    ]);
    const stale = reduce(processing, {
      type: 'PROCESSING_SUCCEEDED',
      requestId: 'req-old',
      turn: makeTurn(),
    });
    expect(stale.state).toBe(processing);
    expect(stale.effects).toHaveLength(0);

    const staleFailure = reduce(processing, {
      type: 'PROCESSING_FAILED',
      requestId: 'req-old',
      error: {
        code: 'X',
        message: 'x',
        retryable: true,
        canRetryUtterance: false,
        canRetryTranslation: false,
      },
    });
    expect(staleFailure.state.status).toBe('PROCESSING_THEM');
  });

  it('cancels the active request when toggling during processing', () => {
    const processing = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'req-1' },
    ]);
    const { state, effects } = reduce(processing, { type: 'TOGGLE_DIRECTION' });
    expect(effects).toContainEqual({ type: 'CANCEL_ACTIVE_REQUEST' });
    expect(state.status).toBe('LISTENING_TO_ME');
    expect(state.activeRequestId).toBeNull();
  });

  it('keeps only one request at a time: a second utterance in processing is ignored', () => {
    const processing = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'req-1' },
    ]);
    const { state, effects } = reduce(processing, {
      type: 'UTTERANCE_COMPLETED',
      requestId: 'req-2',
    });
    expect(state.activeRequestId).toBe('req-1');
    expect(effects).toHaveLength(0);
  });
});

describe('errors and retry', () => {
  const failedState = () =>
    run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'req-1' },
      {
        type: 'PROCESSING_FAILED',
        requestId: 'req-1',
        error: {
          code: 'TRANSCRIPTION_FAILED',
          message: 'Could not understand the audio',
          retryable: true,
          canRetryUtterance: true,
          canRetryTranslation: false,
        },
      },
    ]);

  it('moves to ERROR on processing failure', () => {
    const state = failedState();
    expect(state.status).toBe('ERROR');
    expect(state.lastError?.code).toBe('TRANSCRIPTION_FAILED');
  });

  it('RETRY re-sends the failed utterance when possible', () => {
    const { state, effects } = reduce(failedState(), { type: 'RETRY', requestId: 'req-2' });
    expect(state.status).toBe('PROCESSING_THEM');
    expect(state.activeRequestId).toBe('req-2');
    expect(effects).toContainEqual({ type: 'RETRY_LAST_UTTERANCE', requestId: 'req-2' });
  });

  it('RETRY returns to listening when the utterance cannot be retried', () => {
    const errored = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'req-1' },
      {
        type: 'PROCESSING_FAILED',
        requestId: 'req-1',
        error: {
          code: 'NO_SPEECH_DETECTED',
          message: 'No speech detected',
          retryable: true,
          canRetryUtterance: false,
          canRetryTranslation: false,
        },
      },
    ]);
    const { state, effects } = reduce(errored, { type: 'RETRY', requestId: 'req-2' });
    expect(state.status).toBe('LISTENING_TO_THEM');
    expect(effects).toContainEqual({ type: 'SET_MIC', open: true });
  });

  it('MIC_FAILED is a hard error from any state', () => {
    const listening = run([{ type: 'START_CONVERSATION' }]);
    const { state } = reduce(listening, {
      type: 'MIC_FAILED',
      error: {
        code: 'MIC_PERMISSION_DENIED',
        message: 'Microphone unavailable',
        retryable: false,
        canRetryUtterance: false,
        canRetryTranslation: false,
      },
    });
    expect(state.status).toBe('ERROR');
  });
});

describe('history browsing', () => {
  const withTwoTurns = () =>
    run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'r1' },
      { type: 'PROCESSING_SUCCEEDED', requestId: 'r1', turn: makeTurn({ id: 't1' }) },
      { type: 'RESULT_DISPLAY_ELAPSED' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'r2' },
      { type: 'PROCESSING_SUCCEEDED', requestId: 'r2', turn: makeTurn({ id: 't2' }) },
      { type: 'RESULT_DISPLAY_ELAPSED' },
    ]);

  it('enters browsing at the newest item and steps backwards', () => {
    const live = withTwoTurns();
    expect(live.status).toBe('LISTENING_TO_THEM');

    const browsing = reduce(live, { type: 'HISTORY_PREVIOUS' });
    expect(browsing.state.status).toBe('BROWSING_HISTORY');
    expect(browsing.state.historyIndex).toBe(1);
    expect(browsing.effects).toContainEqual({ type: 'SET_MIC', open: false });

    const older = reduce(browsing.state, { type: 'HISTORY_PREVIOUS' });
    expect(older.state.historyIndex).toBe(0);

    // Clamp at the oldest item.
    const clamped = reduce(older.state, { type: 'HISTORY_PREVIOUS' });
    expect(clamped.state.historyIndex).toBe(0);
  });

  it('HISTORY_NEXT walks forward and exits past the newest item', () => {
    const live = withTwoTurns();
    let state = reduce(live, { type: 'HISTORY_PREVIOUS' }).state;
    state = reduce(state, { type: 'HISTORY_PREVIOUS' }).state; // index 0

    state = reduce(state, { type: 'HISTORY_NEXT' }).state;
    expect(state.historyIndex).toBe(1);

    const exit = reduce(state, { type: 'HISTORY_NEXT' });
    expect(exit.state.status).toBe('LISTENING_TO_THEM');
    expect(exit.state.historyIndex).toBeNull();
    expect(exit.effects).toContainEqual({ type: 'SET_MIC', open: true });
  });

  it('ignores browsing events when there is no history', () => {
    const listening = run([{ type: 'START_CONVERSATION' }]);
    const { state } = reduce(listening, { type: 'HISTORY_PREVIOUS' });
    expect(state.status).toBe('LISTENING_TO_THEM');
  });

  it('R1 while browsing returns to the state browsing started from', () => {
    // Enter browsing from READ_ALOUD_PAUSED: R1 must return there, keeping
    // the mic off so the user can still read the sentence aloud.
    const readAloud = run([
      { type: 'START_CONVERSATION' },
      { type: 'TOGGLE_DIRECTION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'r1' },
      {
        type: 'PROCESSING_SUCCEEDED',
        requestId: 'r1',
        turn: makeTurn({ direction: 'me-to-them' }),
      },
    ]);
    expect(readAloud.status).toBe('READ_ALOUD_PAUSED');

    const browsing = reduce(readAloud, { type: 'HISTORY_PREVIOUS' }).state;
    expect(browsing.status).toBe('BROWSING_HISTORY');

    const back = reduce(browsing, { type: 'TOGGLE_DIRECTION' });
    expect(back.state.status).toBe('READ_ALOUD_PAUSED');
    expect(back.state.historyIndex).toBeNull();
    expect(back.effects).not.toContainEqual({ type: 'SET_MIC', open: true });
  });

  it('a new manual result while browsing returns the display to live mode', () => {
    const browsing = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'r1' },
      { type: 'PROCESSING_SUCCEEDED', requestId: 'r1', turn: makeTurn() },
      { type: 'RESULT_DISPLAY_ELAPSED' },
      { type: 'HISTORY_PREVIOUS' },
    ]);
    expect(browsing.status).toBe('BROWSING_HISTORY');

    const { state } = reduce(browsing, {
      type: 'MANUAL_INPUT_SUBMITTED',
      requestId: 'm1',
      direction: 'them-to-me',
      text: 'hola',
    });
    expect(state.status).toBe('PROCESSING_THEM');
    expect(state.historyIndex).toBeNull();
    expect(state.browsingReturnStatus).toBeNull();
  });

  it('caps history at maxHistoryItems', () => {
    let state = run([{ type: 'START_CONVERSATION' }]);
    for (let i = 0; i < 25; i += 1) {
      state = run(
        [
          { type: 'UTTERANCE_COMPLETED', requestId: `r${i}` },
          { type: 'PROCESSING_SUCCEEDED', requestId: `r${i}`, turn: makeTurn({ id: `t${i}` }) },
          { type: 'RESULT_DISPLAY_ELAPSED' },
        ],
        state,
      );
    }
    expect(state.history).toHaveLength(20);
    expect(state.history[0]?.id).toBe('t5');
  });
});

describe('offline behaviour', () => {
  it('goes OFFLINE from any state and cancels active work', () => {
    const processing = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'req-1' },
    ]);
    const { state, effects } = reduce(processing, { type: 'NETWORK_OFFLINE' });
    expect(state.status).toBe('OFFLINE');
    expect(state.online).toBe(false);
    expect(effects).toContainEqual({ type: 'CANCEL_ACTIVE_REQUEST' });
    expect(effects).toContainEqual({ type: 'SET_MIC', open: false });
  });

  it('resumes listening when connectivity returns mid-conversation', () => {
    const offline = run([
      { type: 'START_CONVERSATION' },
      { type: 'TOGGLE_DIRECTION' },
      { type: 'NETWORK_OFFLINE' },
    ]);
    const { state, effects } = reduce(offline, { type: 'NETWORK_ONLINE' });
    expect(state.status).toBe('LISTENING_TO_ME');
    expect(effects).toContainEqual({ type: 'SET_MIC', open: true });
  });

  it('returns to SETUP when back online without an active conversation', () => {
    const offline = run([{ type: 'NETWORK_OFFLINE' }]);
    const { state } = reduce(offline, { type: 'NETWORK_ONLINE' });
    expect(state.status).toBe('SETUP');
  });

  it('preserves history across offline periods', () => {
    const state = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'r1' },
      { type: 'PROCESSING_SUCCEEDED', requestId: 'r1', turn: makeTurn() },
      { type: 'NETWORK_OFFLINE' },
      { type: 'NETWORK_ONLINE' },
    ]);
    expect(state.history).toHaveLength(1);
  });
});

describe('manual input', () => {
  it('routes manual me-to-them input through PROCESSING_ME to READ_ALOUD_PAUSED', () => {
    const initial = initialMachineState(true);
    const { state, effects } = reduce(initial, {
      type: 'MANUAL_INPUT_SUBMITTED',
      requestId: 'm1',
      direction: 'me-to-them',
      text: 'Where is the station?',
    });
    expect(state.status).toBe('PROCESSING_ME');
    // Manual input skips transcription: the typed text is the transcript.
    expect(state.processingPhase).toBe('translating');
    expect(state.currentTranscript).toBe('Where is the station?');
    expect(effects).toContainEqual({ type: 'BEGIN_REQUEST', requestId: 'm1', kind: 'manual' });

    const done = reduce(state, {
      type: 'PROCESSING_SUCCEEDED',
      requestId: 'm1',
      turn: makeTurn({ direction: 'me-to-them' }),
    });
    expect(done.state.status).toBe('READ_ALOUD_PAUSED');
  });

  it('refuses manual input while another request is active', () => {
    const processing = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'req-1' },
    ]);
    const { state, effects } = reduce(processing, {
      type: 'MANUAL_INPUT_SUBMITTED',
      requestId: 'm1',
      direction: 'me-to-them',
      text: 'hello',
    });
    expect(state.activeRequestId).toBe('req-1');
    expect(effects).toHaveLength(0);
  });

  it('refuses manual input while offline', () => {
    const offline = run([{ type: 'NETWORK_OFFLINE' }]);
    const { state } = reduce(offline, {
      type: 'MANUAL_INPUT_SUBMITTED',
      requestId: 'm1',
      direction: 'me-to-them',
      text: 'hello',
    });
    expect(state.status).toBe('OFFLINE');
  });
});

describe('two-stage processing phases and transient transcript', () => {
  const processing = () =>
    run([{ type: 'START_CONVERSATION' }, { type: 'UTTERANCE_COMPLETED', requestId: 'req-1' }]);

  it('enters PROCESSING with phase transcribing and no transcript', () => {
    const state = processing();
    expect(state.processingPhase).toBe('transcribing');
    expect(state.currentTranscript).toBeNull();
  });

  it('TRANSCRIPTION_SUCCEEDED stores the transcript and moves to translating', () => {
    const { state, effects } = reduce(processing(), {
      type: 'TRANSCRIPTION_SUCCEEDED',
      requestId: 'req-1',
      transcript: '¿Dónde está la estación?',
    });
    expect(state.status).toBe('PROCESSING_THEM');
    expect(state.processingPhase).toBe('translating');
    expect(state.currentTranscript).toBe('¿Dónde está la estación?');
    expect(effects).toHaveLength(0);
  });

  it('ignores a stale TRANSCRIPTION_SUCCEEDED from a previous utterance', () => {
    const state = processing();
    const stale = reduce(state, {
      type: 'TRANSCRIPTION_SUCCEEDED',
      requestId: 'req-old',
      transcript: 'stale text',
    });
    expect(stale.state).toBe(state);
    expect(stale.state.currentTranscript).toBeNull();
  });

  it('keeps the transcript between transcription success and translation success', () => {
    const midTranslation = reduce(processing(), {
      type: 'TRANSCRIPTION_SUCCEEDED',
      requestId: 'req-1',
      transcript: 'hola',
    }).state;
    expect(midTranslation.currentTranscript).toBe('hola');

    const done = reduce(midTranslation, {
      type: 'PROCESSING_SUCCEEDED',
      requestId: 'req-1',
      turn: makeTurn(),
    }).state;
    expect(done.currentTranscript).toBeNull();
    expect(done.processingPhase).toBe('idle');
  });

  it('preserves the transcript when translation fails', () => {
    const midTranslation = reduce(processing(), {
      type: 'TRANSCRIPTION_SUCCEEDED',
      requestId: 'req-1',
      transcript: 'hola',
    }).state;
    const failed = reduce(midTranslation, {
      type: 'PROCESSING_FAILED',
      requestId: 'req-1',
      error: {
        code: 'TRANSLATION_FAILED',
        message: 'Translation failed — try again',
        retryable: true,
        canRetryUtterance: false,
        canRetryTranslation: true,
      },
    }).state;
    expect(failed.status).toBe('ERROR');
    expect(failed.currentTranscript).toBe('hola');
    expect(failed.processingPhase).toBe('idle');
  });

  it('RETRY after a translation failure re-runs translation only, keeping the transcript', () => {
    const failed = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'req-1' },
      { type: 'TRANSCRIPTION_SUCCEEDED', requestId: 'req-1', transcript: 'hola' },
      {
        type: 'PROCESSING_FAILED',
        requestId: 'req-1',
        error: {
          code: 'TRANSLATION_FAILED',
          message: 'Translation failed — try again',
          retryable: true,
          canRetryUtterance: false,
          canRetryTranslation: true,
        },
      },
    ]);
    const { state, effects } = reduce(failed, { type: 'RETRY', requestId: 'req-2' });
    expect(state.status).toBe('PROCESSING_THEM');
    expect(state.processingPhase).toBe('translating');
    expect(state.currentTranscript).toBe('hola');
    expect(effects).toContainEqual({ type: 'RETRY_TRANSLATION', requestId: 'req-2' });
    expect(effects).not.toContainEqual({ type: 'RETRY_LAST_UTTERANCE', requestId: 'req-2' });
  });

  it('clears the transcript on direction toggle mid-processing', () => {
    const midTranslation = reduce(processing(), {
      type: 'TRANSCRIPTION_SUCCEEDED',
      requestId: 'req-1',
      transcript: 'hola',
    }).state;
    const { state, effects } = reduce(midTranslation, { type: 'TOGGLE_DIRECTION' });
    expect(state.currentTranscript).toBeNull();
    expect(state.processingPhase).toBe('idle');
    expect(effects).toContainEqual({ type: 'CANCEL_ACTIVE_REQUEST' });
  });

  it('clears the transcript when going offline', () => {
    const midTranslation = reduce(processing(), {
      type: 'TRANSCRIPTION_SUCCEEDED',
      requestId: 'req-1',
      transcript: 'hola',
    }).state;
    const { state } = reduce(midTranslation, { type: 'NETWORK_OFFLINE' });
    expect(state.currentTranscript).toBeNull();
    expect(state.processingPhase).toBe('idle');
  });

  it('clears the transcript on END_CONVERSATION and EXIT', () => {
    const midTranslation = reduce(processing(), {
      type: 'TRANSCRIPTION_SUCCEEDED',
      requestId: 'req-1',
      transcript: 'hola',
    }).state;
    expect(reduce(midTranslation, { type: 'END_CONVERSATION' }).state.currentTranscript).toBeNull();
    expect(reduce(midTranslation, { type: 'EXIT' }).state.currentTranscript).toBeNull();
  });

  it('clears a leftover transcript when a new utterance starts', () => {
    const errored = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'req-1' },
      { type: 'TRANSCRIPTION_SUCCEEDED', requestId: 'req-1', transcript: 'hola' },
      {
        type: 'PROCESSING_FAILED',
        requestId: 'req-1',
        error: {
          code: 'TRANSLATION_FAILED',
          message: 'x',
          retryable: false,
          canRetryUtterance: false,
          canRetryTranslation: false,
        },
      },
      { type: 'RETRY', requestId: 'req-2' }, // Not retryable → back to listening.
    ]);
    expect(errored.status).toBe('LISTENING_TO_THEM');
    expect(errored.currentTranscript).toBeNull();

    const speaking = reduce(errored, { type: 'SPEECH_STARTED' }).state;
    expect(speaking.currentTranscript).toBeNull();

    const next = reduce(speaking, { type: 'UTTERANCE_COMPLETED', requestId: 'req-3' }).state;
    expect(next.currentTranscript).toBeNull();
    expect(next.processingPhase).toBe('transcribing');
  });
});

describe('live partial previews', () => {
  const speaking = () => run([{ type: 'START_CONVERSATION' }, { type: 'SPEECH_STARTED' }]);

  it('stores partial previews and clears an outdated translation when the transcript changes', () => {
    let state = speaking();

    // First partial transcript arrives.
    state = reduce(state, {
      type: 'PARTIAL_TRANSCRIPT',
      transcript: 'Dónde está',
    }).state;

    expect(state.partialTranscript).toBe('Dónde está');
    expect(state.partialTranslation).toBeNull();

    // Translation corresponding to the first transcript arrives.
    state = reduce(state, {
      type: 'PARTIAL_TRANSLATION',
      translation: 'Where is',
    }).state;

    expect(state.partialTranscript).toBe('Dónde está');
    expect(state.partialTranslation).toBe('Where is');

    // Whisper produces a newer, longer transcript. The previous translation
    // belongs to the older transcript and must therefore be removed.
    state = reduce(state, {
      type: 'PARTIAL_TRANSCRIPT',
      transcript: 'Dónde está la estación',
    }).state;

    expect(state.partialTranscript).toBe('Dónde está la estación');
    expect(state.partialTranslation).toBeNull();

    // The fresh translation corresponding to the newer transcript arrives.
    state = reduce(state, {
      type: 'PARTIAL_TRANSLATION',
      translation: 'Where is the station',
    }).state;

    expect(state.partialTranscript).toBe('Dónde está la estación');
    expect(state.partialTranslation).toBe('Where is the station');
  });

  it('ignores partials when nobody is speaking', () => {
    const listening = run([{ type: 'START_CONVERSATION' }]);
    const { state } = reduce(listening, { type: 'PARTIAL_TRANSCRIPT', transcript: 'ghost' });
    expect(state.partialTranscript).toBeNull();

    const noTranscript = reduce(speaking(), {
      type: 'PARTIAL_TRANSLATION',
      translation: 'orphan',
    });
    expect(noTranscript.state.partialTranslation).toBeNull();
  });

  it('keeps the last partial through UTTERANCE_COMPLETED for the transcribing screen', () => {
    let state = speaking();
    state = reduce(state, { type: 'PARTIAL_TRANSCRIPT', transcript: 'Dónde está' }).state;
    state = reduce(state, { type: 'UTTERANCE_COMPLETED', requestId: 'r1' }).state;
    expect(state.status).toBe('PROCESSING_THEM');
    expect(state.partialTranscript).toBe('Dónde está');
  });

  it('replaces the partial with the authoritative final transcript', () => {
    let state = speaking();
    state = reduce(state, { type: 'PARTIAL_TRANSCRIPT', transcript: 'Dónde está' }).state;
    state = reduce(state, { type: 'UTTERANCE_COMPLETED', requestId: 'r1' }).state;
    state = reduce(state, {
      type: 'TRANSCRIPTION_SUCCEEDED',
      requestId: 'r1',
      transcript: '¿Dónde está la estación?',
    }).state;
    expect(state.partialTranscript).toBeNull();
    expect(state.partialTranslation).toBeNull();
    expect(state.currentTranscript).toBe('¿Dónde está la estación?');
  });

  it('clears partials on a new utterance, toggle, offline and completion', () => {
    const withPartial = () => {
      let state = speaking();
      state = reduce(state, { type: 'PARTIAL_TRANSCRIPT', transcript: 'so far' }).state;
      return state;
    };

    expect(reduce(withPartial(), { type: 'SPEECH_STARTED' }).state.partialTranscript).toBeNull();
    expect(reduce(withPartial(), { type: 'TOGGLE_DIRECTION' }).state.partialTranscript).toBeNull();
    expect(reduce(withPartial(), { type: 'NETWORK_OFFLINE' }).state.partialTranscript).toBeNull();
    expect(reduce(withPartial(), { type: 'END_CONVERSATION' }).state.partialTranscript).toBeNull();

    let state = reduce(withPartial(), { type: 'UTTERANCE_COMPLETED', requestId: 'r1' }).state;
    state = reduce(state, { type: 'TRANSCRIPTION_SUCCEEDED', requestId: 'r1', transcript: 'x' })
      .state;
    state = reduce(state, { type: 'PROCESSING_SUCCEEDED', requestId: 'r1', turn: makeTurn() })
      .state;
    expect(state.partialTranscript).toBeNull();
    expect(state.partialTranslation).toBeNull();
  });
});

describe('exit and end', () => {
  it('EXIT cancels everything and shuts down', () => {
    const processing = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'req-1' },
    ]);
    const { state, effects } = reduce(processing, { type: 'EXIT' });
    expect(state.status).toBe('EXITING');
    expect(effects).toContainEqual({ type: 'CANCEL_ACTIVE_REQUEST' });
    expect(effects).toContainEqual({ type: 'SHUTDOWN' });
    expect(effects).toContainEqual({ type: 'SET_MIC', open: false });
  });

  it('EXITING absorbs all further events', () => {
    const exiting = run([{ type: 'START_CONVERSATION' }, { type: 'EXIT' }]);
    const { state, effects } = reduce(exiting, { type: 'START_CONVERSATION' });
    expect(state.status).toBe('EXITING');
    expect(effects).toHaveLength(0);
  });

  it('END_CONVERSATION returns to SETUP and keeps history', () => {
    const state = run([
      { type: 'START_CONVERSATION' },
      { type: 'UTTERANCE_COMPLETED', requestId: 'r1' },
      { type: 'PROCESSING_SUCCEEDED', requestId: 'r1', turn: makeTurn() },
      { type: 'END_CONVERSATION' },
    ]);
    expect(state.status).toBe('SETUP');
    expect(state.conversationActive).toBe(false);
    expect(state.history).toHaveLength(1);
  });
});
