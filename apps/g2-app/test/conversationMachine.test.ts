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
      error: { code: 'X', message: 'x', retryable: true, canRetryUtterance: false },
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
    });
    expect(state.status).toBe('PROCESSING_ME');
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
    });
    expect(state.status).toBe('OFFLINE');
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
