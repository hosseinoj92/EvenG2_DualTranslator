import { describe, expect, it } from 'vitest';
import type { DisplayInput } from '../src/even/displayModel';
import {
  BODY_BUDGETS,
  buildDisplayModel,
  composeHistoryBody,
  composeIncomingBody,
  composeTranslationPendingBody,
} from '../src/even/displayModel';
import type { ConversationTurn } from '../src/types';

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

function makeInput(overrides: Partial<DisplayInput> = {}): DisplayInput {
  return {
    status: 'SETUP',
    direction: 'them-to-me',
    processingPhase: 'idle',
    currentTranscript: null,
    partialTranscript: null,
    partialTranslation: null,
    settings: { myLanguage: 'en', otherLanguage: 'es' },
    latestTurn: null,
    browsingTurn: null,
    historyIndex: null,
    historyLength: 0,
    error: null,
    ...overrides,
  };
}

describe('incoming (them-to-me) layouts', () => {
  it('listening: THEM header, Listening… body, toggle hint footer', () => {
    const model = buildDisplayModel(makeInput({ status: 'LISTENING_TO_THEM' }));
    expect(model.header).toBe('THEM');
    expect(model.body).toBe('Listening…');
    expect(model.footer).toBe('R1: your turn');
  });

  it('transcribing: Processing speech…', () => {
    const model = buildDisplayModel(
      makeInput({ status: 'PROCESSING_THEM', processingPhase: 'transcribing' }),
    );
    expect(model.header).toBe('THEM');
    expect(model.body).toBe('Processing speech…');
    expect(model.footer).toBe('Please wait');
  });

  it('translation pending: completed transcript is visible with Translating…', () => {
    const model = buildDisplayModel(
      makeInput({
        status: 'PROCESSING_THEM',
        processingPhase: 'translating',
        currentTranscript: '¿Dónde está la estación?',
      }),
    );
    expect(model.header).toBe('THEY SAID');
    expect(model.body).toContain('¿Dónde está la estación?');
    expect(model.body).toContain('Translating…');
  });

  it('completed: body contains transcript and translation', () => {
    const model = buildDisplayModel(
      makeInput({ status: 'SHOWING_THEM_RESULT', latestTurn: makeTurn() }),
    );
    expect(model.header).toBe('THEY SAID');
    expect(model.body).toContain('¿Dónde está la estación?');
    expect(model.body).toContain('→ Where is the station?');
    expect(model.footer).toBe('R1: your turn');
  });

  it('completed layouts contain no language-code decorations', () => {
    const states: DisplayInput[] = [
      makeInput({ status: 'LISTENING_TO_THEM' }),
      makeInput({ status: 'PROCESSING_THEM', processingPhase: 'transcribing' }),
      makeInput({ status: 'SHOWING_THEM_RESULT', latestTurn: makeTurn() }),
      makeInput({ status: 'LISTENING_TO_ME', direction: 'me-to-them' }),
      makeInput({ status: 'PROCESSING_ME', direction: 'me-to-them' }),
    ];
    for (const input of states) {
      const model = buildDisplayModel(input);
      expect(model.header).not.toMatch(/\bES\b|\bEN\b|→\s*[A-Z]{2}\b/);
    }
  });
});

describe('outgoing (me-to-them) layouts', () => {
  it('listening: YOUR TURN header names the user language dynamically', () => {
    const model = buildDisplayModel(
      makeInput({ status: 'LISTENING_TO_ME', direction: 'me-to-them' }),
    );
    expect(model.header).toBe('YOUR TURN');
    expect(model.body).toBe('Speak English…');
    expect(model.footer).toBe('R1: cancel');

    const german = buildDisplayModel(
      makeInput({
        status: 'LISTENING_TO_ME',
        direction: 'me-to-them',
        settings: { myLanguage: 'de', otherLanguage: 'fr' },
      }),
    );
    expect(german.body).toBe('Speak German…');
  });

  it('transcribing: YOU header with Processing speech…', () => {
    const model = buildDisplayModel(
      makeInput({
        status: 'PROCESSING_ME',
        direction: 'me-to-them',
        processingPhase: 'transcribing',
      }),
    );
    expect(model.header).toBe('YOU');
    expect(model.body).toBe('Processing speech…');
  });

  it('translation pending: YOU SAID with the transcript and Translating…', () => {
    const model = buildDisplayModel(
      makeInput({
        status: 'PROCESSING_ME',
        direction: 'me-to-them',
        processingPhase: 'translating',
        currentTranscript: 'Where is the station?',
      }),
    );
    expect(model.header).toBe('YOU SAID');
    expect(model.body).toContain('Where is the station?');
    expect(model.body).toContain('Translating…');
  });

  it('completed: translation dominates, original sentence is not repeated', () => {
    const turn = makeTurn({
      direction: 'me-to-them',
      sourceLanguage: 'en',
      targetLanguage: 'es',
      transcript: 'Where is the station?',
      translation: '¿Dónde está la estación?',
    });
    const model = buildDisplayModel(makeInput({ status: 'READ_ALOUD_PAUSED', latestTurn: turn }));
    expect(model.header).toBe('SAY THIS IN SPANISH');
    expect(model.body).toBe('¿Dónde está la estación?');
    expect(model.body).not.toContain('Where is the station?');
    expect(model.footer).toBe('R1: listen to them');
  });

  it('SAY THIS IN … uses the language stored in the turn', () => {
    const turn = makeTurn({
      direction: 'me-to-them',
      sourceLanguage: 'en',
      targetLanguage: 'tr',
      transcript: 'Good morning',
      translation: 'Günaydın',
    });
    const model = buildDisplayModel(makeInput({ status: 'READ_ALOUD_PAUSED', latestTurn: turn }));
    expect(model.header).toBe('SAY THIS IN TURKISH');
    expect(model.body).toBe('Günaydın');
  });

  it('outgoing translation receives the dominant body budget', () => {
    expect(BODY_BUDGETS.outgoingTranslation).toBeGreaterThan(BODY_BUDGETS.translation);
    const long = 'palabra '.repeat(40).trim();
    const turn = makeTurn({ direction: 'me-to-them', targetLanguage: 'es', translation: long });
    const model = buildDisplayModel(makeInput({ status: 'READ_ALOUD_PAUSED', latestTurn: turn }));
    expect(model.body.length).toBeGreaterThan(BODY_BUDGETS.translation);
  });
});

describe('live preview layouts', () => {
  it('shows the partial transcript while they are still speaking', () => {
    const model = buildDisplayModel(
      makeInput({ status: 'LISTENING_TO_THEM', partialTranscript: 'Dónde está la' }),
    );
    expect(model.header).toBe('THEM');
    expect(model.body).toBe('Dónde está la');
    expect(model.footer).toBe('R1: your turn');
  });

  it('adds the partial translation once it arrives', () => {
    const model = buildDisplayModel(
      makeInput({
        status: 'LISTENING_TO_THEM',
        partialTranscript: 'Dónde está la estación',
        partialTranslation: 'Where is the station',
      }),
    );
    expect(model.body).toBe('Dónde está la estación\n\n→ Where is the station');
  });

  it('shows the live preview for the outgoing direction too', () => {
    const model = buildDisplayModel(
      makeInput({
        status: 'LISTENING_TO_ME',
        direction: 'me-to-them',
        partialTranscript: 'Where is the',
        partialTranslation: 'Dónde está',
      }),
    );
    expect(model.header).toBe('YOUR TURN');
    expect(model.body).toBe('Where is the\n\n→ Dónde está');
    expect(model.footer).toBe('R1: cancel');
  });

  it('keeps the last preview visible while the final transcription runs', () => {
    const model = buildDisplayModel(
      makeInput({
        status: 'PROCESSING_THEM',
        processingPhase: 'transcribing',
        partialTranscript: 'Dónde está la estación',
      }),
    );
    expect(model.header).toBe('THEM');
    expect(model.body).toBe('Dónde está la estación\n\nProcessing speech…');
    expect(model.footer).toBe('Please wait');
  });

  it('the final transcript screen wins over any leftover preview', () => {
    const model = buildDisplayModel(
      makeInput({
        status: 'PROCESSING_THEM',
        processingPhase: 'translating',
        currentTranscript: '¿Dónde está la estación?',
        partialTranscript: 'stale preview',
      }),
    );
    expect(model.header).toBe('THEY SAID');
    expect(model.body).toContain('¿Dónde está la estación?');
    expect(model.body).not.toContain('stale preview');
  });
});

describe('composed bodies', () => {
  it('composeIncomingBody keeps both parts on separate lines', () => {
    const body = composeIncomingBody({
      transcript: '¿Dónde está la estación?',
      translation: 'Where is the station?',
    });
    expect(body).toBe('¿Dónde está la estación?\n\n→ Where is the station?');
  });

  it('truncates source and translation independently — a long transcript never hides the translation', () => {
    const longSource = 'palabra '.repeat(60).trim();
    const body = composeIncomingBody({
      transcript: longSource,
      translation: 'Where is the station?',
    });
    expect(body).toContain('→ Where is the station?');
    const [sourcePart] = body.split('\n\n');
    expect(sourcePart!.length).toBeLessThanOrEqual(BODY_BUDGETS.source);
    expect(sourcePart!.endsWith('…')).toBe(true);
  });

  it('gives the translation a larger budget than the source', () => {
    expect(BODY_BUDGETS.translation).toBeGreaterThan(BODY_BUDGETS.source);
    const longTranslation = 'word '.repeat(60).trim();
    const body = composeIncomingBody({ transcript: 'hola', translation: longTranslation });
    const translationPart = body.split('\n\n→ ')[1]!;
    expect(translationPart.length).toBeLessThanOrEqual(BODY_BUDGETS.translation);
    expect(translationPart.endsWith('…')).toBe(true);
  });

  it('preserves Unicode, accents and non-English punctuation', () => {
    const body = composeIncomingBody({
      transcript: '¿Größe? Ça va! İstanbul’a mı?',
      translation: 'Ünïcode översätts — «правильно»',
    });
    expect(body).toContain('¿Größe? Ça va! İstanbul’a mı?');
    expect(body).toContain('Ünïcode översätts — «правильно»');
  });

  it('strips HTML and Markdown from both parts', () => {
    const body = composeIncomingBody({
      transcript: '<b>hola</b> **mundo**',
      translation: '[hello](http://x) <script>alert(1)</script> world',
    });
    expect(body).not.toContain('<');
    expect(body).not.toContain('**');
    expect(body).not.toContain('](');
    expect(body).toContain('hola mundo');
    expect(body).toContain('hello');
    expect(body).toContain('world');
  });

  it('composeTranslationPendingBody appends Translating… under the transcript', () => {
    expect(composeTranslationPendingBody('Where is the station?')).toBe(
      'Where is the station?\n\nTranslating…',
    );
  });
});

describe('history browsing layouts', () => {
  it('incoming history shows THEM, position, and both texts', () => {
    const model = buildDisplayModel(
      makeInput({
        status: 'BROWSING_HISTORY',
        browsingTurn: makeTurn(),
        historyIndex: 2,
        historyLength: 8,
      }),
    );
    expect(model.header).toBe('HISTORY · 3 / 8 · THEM');
    expect(model.body).toContain('¿Dónde está la estación?');
    expect(model.body).toContain('→ Where is the station?');
    expect(model.footer).toBe('Swipe: browse · R1: live');
  });

  it('outgoing history shows YOU and both texts, translation second', () => {
    const turn = makeTurn({
      direction: 'me-to-them',
      sourceLanguage: 'en',
      targetLanguage: 'es',
      transcript: 'Where is the station?',
      translation: '¿Dónde está la estación?',
    });
    const model = buildDisplayModel(
      makeInput({
        status: 'BROWSING_HISTORY',
        browsingTurn: turn,
        historyIndex: 3,
        historyLength: 8,
      }),
    );
    expect(model.header).toBe('HISTORY · 4 / 8 · YOU');
    expect(model.body).toBe('Where is the station?\n\n→ ¿Dónde está la estación?');
  });

  it('history layout is driven by the stored turn, not current settings', () => {
    // Settings have since been switched to de↔fr; the stored turn is es→en.
    const model = buildDisplayModel(
      makeInput({
        status: 'BROWSING_HISTORY',
        settings: { myLanguage: 'de', otherLanguage: 'fr' },
        browsingTurn: makeTurn(),
        historyIndex: 0,
        historyLength: 1,
      }),
    );
    expect(model.body).toContain('¿Dónde está la estación?');
    expect(model.body).toContain('Where is the station?');
    expect(model.header).toBe('HISTORY · 1 / 1 · THEM');
  });

  it('truncates long history texts independently', () => {
    const turn = makeTurn({
      transcript: 'palabra '.repeat(80).trim(),
      translation: 'word '.repeat(80).trim(),
    });
    const body = composeHistoryBody(turn);
    const [sourcePart, translationPart] = body.split('\n\n→ ');
    expect(sourcePart!.length).toBeLessThanOrEqual(BODY_BUDGETS.source);
    expect(translationPart!.length).toBeLessThanOrEqual(BODY_BUDGETS.translation);
    expect(sourcePart!.endsWith('…')).toBe(true);
    expect(translationPart!.endsWith('…')).toBe(true);
  });
});

describe('error layouts', () => {
  it('transcription failure: COULDN’T HEAR with retry footer', () => {
    const model = buildDisplayModel(
      makeInput({
        status: 'ERROR',
        error: {
          code: 'NO_SPEECH_DETECTED',
          message: 'No speech detected — try again',
          retryable: true,
        },
      }),
    );
    expect(model.header).toBe('COULDN’T HEAR');
    expect(model.body).toBe('Speech was not understood');
    expect(model.footer).toBe('R1: retry');
  });

  it('translation failure after transcription: transcript stays visible', () => {
    const model = buildDisplayModel(
      makeInput({
        status: 'ERROR',
        currentTranscript: 'Where is the station?',
        error: {
          code: 'TRANSLATION_FAILED',
          message: 'Translation failed — try again',
          retryable: true,
        },
      }),
    );
    expect(model.header).toBe('TRANSLATION ERROR');
    expect(model.body).toBe('Where is the station?\n\nTranslation unavailable');
    expect(model.footer).toBe('R1: retry');
  });

  it('never shows stack traces or internal messages', () => {
    const model = buildDisplayModel(
      makeInput({
        status: 'ERROR',
        error: {
          code: 'NETWORK_ERROR',
          message: 'Translation service unavailable',
          retryable: true,
        },
      }),
    );
    expect(model.header).toBe('CONNECTION ERROR');
    expect(model.body).toBe('Translation service unavailable');
  });
});

describe('remaining states', () => {
  it('offline and exiting layouts', () => {
    expect(buildDisplayModel(makeInput({ status: 'OFFLINE' })).header).toBe('OFFLINE');
    expect(buildDisplayModel(makeInput({ status: 'EXITING' })).body).toBe('Closing…');
  });

  it('setup names the language pair once', () => {
    const model = buildDisplayModel(makeInput());
    expect(model.header).toBe('TURNTRANSLATE');
    expect(model.body).toContain('Spanish ↔ English');
    expect(model.footer).toContain('R1: start');
  });
});
