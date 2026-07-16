// @vitest-environment happy-dom
/**
 * Phone companion UI tests. The UI is a pure renderer over AppSnapshot, so
 * these tests mount it into happy-dom, feed snapshots for each stage of the
 * two-stage pipeline and assert on the rendered text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSnapshot, ConversationTurn } from '../src/types';
import type { CompanionUi, CompanionUiCallbacks } from '../src/ui/companionUi';
import { mountCompanionUi } from '../src/ui/companionUi';

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

function makeSnapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    status: 'LISTENING_TO_THEM',
    direction: 'them-to-me',
    settings: { myLanguage: 'en', otherLanguage: 'es' },
    conversationActive: true,
    bridgeConnected: false,
    online: true,
    micOpen: true,
    speechActive: false,
    processingPhase: 'idle',
    currentTranscript: null,
    latestTurn: null,
    bodyPage: 0,
    error: null,
    vad: { rms: 0, speaking: false, state: 'idle' },
    lastLatencyMs: null,
    backendUrl: 'http://localhost:8787',
    ...overrides,
  };
}

function noopCallbacks(): CompanionUiCallbacks {
  return {
    onStartConversation: vi.fn(),
    onEndConversation: vi.fn(),
    onToggleDirection: vi.fn(),
    onSpeakAgain: vi.fn(),
    onSwapLanguages: vi.fn(),
    onSelectMyLanguage: vi.fn(),
    onSelectOtherLanguage: vi.fn(),
    onManualTranslate: vi.fn(),
    onRetry: vi.fn(),
  };
}

let root: HTMLElement;
let ui: CompanionUi;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  ui = mountCompanionUi(root, noopCallbacks());
});

const sourceEl = () => root.querySelector('.tt-transcript .src')!;
const translationEl = () => root.querySelector('.tt-transcript .dst')!;
const speakerEl = () => root.querySelector('.tt-speaker')!;

describe('two-stage result panel', () => {
  it('shows Processing speech… while transcribing', () => {
    ui.update(makeSnapshot({ status: 'PROCESSING_THEM', processingPhase: 'transcribing' }));
    expect(sourceEl().textContent).toBe('Processing speech…');
    expect(translationEl().textContent).toBe('');
  });

  it('shows only Listening… while the other person is speaking — no partial text', () => {
    ui.update(
      makeSnapshot({
        status: 'LISTENING_TO_THEM',
        direction: 'them-to-me',
        speechActive: true,
      }),
    );

    expect(sourceEl().textContent).toBe('Listening…');
    expect(translationEl().textContent).toBe('');
  });

  it('shows only Listening… while the user is speaking — no partial text', () => {
    ui.update(
      makeSnapshot({
        status: 'LISTENING_TO_ME',
        direction: 'me-to-them',
        speechActive: true,
      }),
    );

    expect(sourceEl().textContent).toBe('Listening…');
    expect(translationEl().textContent).toBe('');
  });

  it('exposes no partial preview fields in the snapshot contract', () => {
    const snapshot = makeSnapshot();
    expect('partialTranscript' in snapshot).toBe(false);
    expect('partialTranslation' in snapshot).toBe(false);
  });

  it('shows the transcript with Translating… before translation resolves', () => {
    ui.update(
      makeSnapshot({
        status: 'PROCESSING_THEM',
        processingPhase: 'translating',
        currentTranscript: '¿Dónde está la estación?',
      }),
    );
    expect(sourceEl().textContent).toBe('¿Dónde está la estación?');
    expect(translationEl().textContent).toBe('Translating…');
  });

  it('shows both texts once the turn completes', () => {
    const turn = makeTurn();
    ui.update(makeSnapshot({ status: 'SHOWING_THEM_RESULT', latestTurn: turn }));
    expect(sourceEl().textContent).toBe('¿Dónde está la estación?');
    expect(translationEl().textContent).toBe('Where is the station?');
  });

  it('keeps the transcript visible when translation fails', () => {
    ui.update(
      makeSnapshot({
        status: 'ERROR',
        currentTranscript: 'Where is the station?',
        error: { code: 'TRANSLATION_FAILED', message: 'Translation failed', retryable: true },
      }),
    );
    expect(sourceEl().textContent).toBe('Where is the station?');
    expect(translationEl().textContent).toBe('Translation unavailable');
  });
});

describe('speaker direction', () => {
  it('labels incoming processing as THEM and outgoing as YOU', () => {
    ui.update(
      makeSnapshot({
        status: 'PROCESSING_THEM',
        direction: 'them-to-me',
        processingPhase: 'transcribing',
      }),
    );
    expect(speakerEl().textContent).toBe('THEM');

    ui.update(
      makeSnapshot({
        status: 'PROCESSING_ME',
        direction: 'me-to-them',
        processingPhase: 'transcribing',
      }),
    );
    expect(speakerEl().textContent).toBe('YOU');
  });

  it('labels a completed turn with the speaker who produced it', () => {
    const turn = makeTurn({ direction: 'me-to-them', sourceLanguage: 'en', targetLanguage: 'es' });
    ui.update(makeSnapshot({ status: 'READ_ALOUD_PAUSED', latestTurn: turn }));
    expect(speakerEl().textContent).toBe('YOU');
  });
});

describe('same-speaker-again button', () => {
  const speakAgainButton = () =>
    [...root.querySelectorAll('button')].find(
      (node) => node.textContent === 'Same speaker again',
    )!;

  it('is enabled only while a completed result is shown', () => {
    ui.update(makeSnapshot({ status: 'LISTENING_TO_THEM' }));
    expect(speakAgainButton().disabled).toBe(true);

    ui.update(makeSnapshot({ status: 'SHOWING_THEM_RESULT', latestTurn: makeTurn() }));
    expect(speakAgainButton().disabled).toBe(false);

    ui.update(
      makeSnapshot({
        status: 'READ_ALOUD_PAUSED',
        latestTurn: makeTurn({ direction: 'me-to-them' }),
      }),
    );
    expect(speakAgainButton().disabled).toBe(false);
  });

  it('fires the onSpeakAgain callback', () => {
    const callbacks = noopCallbacks();
    ui = mountCompanionUi(root, callbacks);
    ui.update(makeSnapshot({ status: 'SHOWING_THEM_RESULT', latestTurn: makeTurn() }));
    speakAgainButton().click();
    expect(callbacks.onSpeakAgain).toHaveBeenCalledTimes(1);
  });
});

describe('safe text rendering', () => {
  it('renders model output via textContent — markup is never interpreted', () => {
    const hostile = '<img src=x onerror="window.__pwned = true"><b>bold</b>';
    ui.update(
      makeSnapshot({
        status: 'PROCESSING_THEM',
        processingPhase: 'translating',
        currentTranscript: hostile,
      }),
    );
    expect(sourceEl().textContent).toBe(hostile); // Verbatim text…
    expect(sourceEl().querySelector('img, b')).toBeNull(); // …no elements created.
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('renders a hostile completed turn as inert text', () => {
    const turn = makeTurn({
      transcript: '<script>window.__pwned = true</script>',
      translation: '**not markdown** <i>not html</i>',
    });
    ui.update(makeSnapshot({ status: 'SHOWING_THEM_RESULT', latestTurn: turn }));
    expect(root.querySelector('.tt-transcript script, .tt-transcript i')).toBeNull();
    expect(sourceEl().textContent).toContain('<script>');
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });
});
