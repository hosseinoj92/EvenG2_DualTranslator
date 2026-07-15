/**
 * Pure mapping from app state to the three glasses container texts.
 *
 * The layouts are speaker- and task-oriented: each screen answers exactly one
 * question (who is speaking? what did they say? what does it mean? what should
 * I say aloud?). The language pair is chosen during setup, so language codes
 * are never repeated per turn — a language name appears only where it is
 * genuinely useful ("Speak English…", "SAY THIS IN SPANISH").
 *
 * Free of SDK and bridge concerns so it can be unit tested and previewed in
 * the phone UI. Pixel fitting happens later in DisplayManager; the character
 * budgets here exist so the two halves of a composed body are truncated
 * independently — a long transcript can never push the translation off the
 * panel.
 */

import type { ConversationDirection } from '@turntranslate/shared';
import { getLanguage } from '@turntranslate/shared';
import type { ConversationStatus, ProcessingPhase } from '../conversation/conversationMachine';
import type { ConversationTurn, DisplayModel, LanguageSettings, UserFacingError } from '../types';
import { toDisplayText } from '../utils/text';

/** Everything the display needs to know about the current app state. */
export interface DisplayInput {
  status: ConversationStatus;
  direction: ConversationDirection;
  processingPhase: ProcessingPhase;
  /** Completed transcript while translation is pending or failed. */
  currentTranscript: string | null;
  /** Live preview of the sentence still being spoken. */
  partialTranscript: string | null;
  /** Live preview translation of `partialTranscript`. */
  partialTranslation: string | null;
  settings: LanguageSettings;
  latestTurn: ConversationTurn | null;
  browsingTurn: ConversationTurn | null;
  historyIndex: number | null;
  historyLength: number;
  error: UserFacingError | null;
}

/**
 * Character budgets for composed bodies. The body container fits roughly 300
 * characters; the translation half deliberately gets a slightly larger budget
 * than the source half, and both are truncated independently.
 */
export const BODY_BUDGETS = {
  /** Source transcript in an incoming (or history) two-part body. */
  source: 120,
  /** Translation in an incoming (or history) two-part body. */
  translation: 160,
  /** Transcript shown alone while translation is pending or failed. */
  pendingTranscript: 220,
  /** Outgoing final translation — receives almost the whole body. */
  outgoingTranslation: 300,
} as const;

/**
 * Incoming completed result: the recognized sentence and its translation stay
 * together so the user can compare them. Truncated independently, translation
 * gets the bigger share.
 */
export function composeIncomingBody(parts: { transcript: string; translation: string }): string {
  const source = toDisplayText(parts.transcript, BODY_BUDGETS.source);
  const translation = toDisplayText(parts.translation, BODY_BUDGETS.translation);
  return `${source}\n\n→ ${translation}`;
}

/** Transcript is in, translation still running (either direction). */
export function composeTranslationPendingBody(transcript: string): string {
  return `${toDisplayText(transcript, BODY_BUDGETS.pendingTranscript)}\n\nTranslating…`;
}

/**
 * Live preview while the speaker is still talking: what has been said so far,
 * plus its translation once the first preview pass returns one.
 */
export function composeLivePartialBody(parts: {
  transcript: string;
  translation: string | null;
}): string {
  /*
   * Live screens intentionally show transcription only.
   *
   * Even if stale partial-translation state somehow exists, it is ignored.
   * Actual translated text appears only in SHOWING_THEM_RESULT or
   * READ_ALOUD_PAUSED after the final translation completes.
   */
  return toDisplayText(parts.transcript, BODY_BUDGETS.pendingTranscript);
}

/**
 * One history entry always shows both texts — original first, translation
 * second — using the languages stored in the turn, never current settings.
 */
export function composeHistoryBody(turn: ConversationTurn): string {
  return composeIncomingBody({ transcript: turn.transcript, translation: turn.translation });
}

export function buildDisplayModel(input: DisplayInput): DisplayModel {
  const my = getLanguage(input.settings.myLanguage);
  const other = getLanguage(input.settings.otherLanguage);

  switch (input.status) {
    case 'SETUP':
      return {
        header: 'TURNTRANSLATE',
        body: `${other.name} ↔ ${my.name}\n\nTap to start the conversation`,
        footer: 'R1: start · double-tap: exit',
      };

    case 'LISTENING_TO_THEM':
      // While they are talking, the preview loop writes what has been said so
      // far (and its translation) every interval instead of a blank screen.
      if (input.partialTranscript !== null) {
        return {
          header: 'THEM',
          body: composeLivePartialBody({
            transcript: input.partialTranscript,
            translation: input.partialTranslation,
          }),
          footer: 'R1: your turn',
        };
      }
      return {
        header: 'THEM',
        body: 'Listening…',
        footer: 'R1: your turn',
      };

    case 'PROCESSING_THEM':
      if (input.processingPhase === 'translating' && input.currentTranscript !== null) {
        return {
          header: 'THEY SAID',
          body: composeTranslationPendingBody(input.currentTranscript),
          footer: '',
        };
      }
      // The last live preview stays up while the final transcription runs.
      if (input.partialTranscript !== null) {
        return {
          header: 'THEM',
          body: `${toDisplayText(input.partialTranscript, BODY_BUDGETS.pendingTranscript)}\n\nProcessing speech…`,
          footer: 'Please wait',
        };
      }
      return { header: 'THEM', body: 'Processing speech…', footer: 'Please wait' };

    case 'SHOWING_THEM_RESULT':
      return {
        header: 'THEY SAID',
        body: input.latestTurn
          ? composeIncomingBody({
              transcript: input.latestTurn.transcript,
              translation: input.latestTurn.translation,
            })
          : '',
        footer: 'R1: your turn',
      };

    case 'LISTENING_TO_ME':
      if (input.partialTranscript !== null) {
        return {
          header: 'YOUR TURN',
          body: composeLivePartialBody({
            transcript: input.partialTranscript,
            translation: input.partialTranslation,
          }),
          footer: 'R1: cancel',
        };
      }
      return {
        header: 'YOUR TURN',
        body: `Speak ${my.name}…`,
        footer: 'R1: cancel',
      };

    case 'PROCESSING_ME':
      if (input.processingPhase === 'translating' && input.currentTranscript !== null) {
        return {
          header: 'YOU SAID',
          body: composeTranslationPendingBody(input.currentTranscript),
          footer: '',
        };
      }
      if (input.partialTranscript !== null) {
        return {
          header: 'YOU',
          body: `${toDisplayText(input.partialTranscript, BODY_BUDGETS.pendingTranscript)}\n\nProcessing speech…`,
          footer: 'Please wait',
        };
      }
      return { header: 'YOU', body: 'Processing speech…', footer: 'Please wait' };

    case 'READ_ALOUD_PAUSED': {
      // The sentence to read aloud dominates: header carries the instruction,
      // the body holds only the translation with the full space budget. The
      // original sentence stays available on the phone and in history.
      const turn =
        input.latestTurn && input.latestTurn.direction === 'me-to-them' ? input.latestTurn : null;
      const sayLanguage = turn ? getLanguage(turn.targetLanguage) : other;
      return {
        header: `SAY THIS IN ${sayLanguage.name.toUpperCase()}`,
        body: turn ? toDisplayText(turn.translation, BODY_BUDGETS.outgoingTranslation) : '',
        footer: 'R1: listen to them',
      };
    }

    case 'BROWSING_HISTORY': {
      const turn = input.browsingTurn;
      const position = input.historyIndex === null ? 0 : input.historyIndex + 1;
      const speaker = turn?.direction === 'me-to-them' ? 'YOU' : 'THEM';
      return {
        header: `HISTORY · ${position} / ${input.historyLength} · ${speaker}`,
        body: turn ? composeHistoryBody(turn) : '',
        footer: 'Swipe: browse · R1: live',
      };
    }

    case 'OFFLINE':
      return {
        header: 'OFFLINE',
        body: 'No internet connection',
        footer: 'Waiting for network…',
      };

    case 'ERROR':
      return buildErrorModel(input);

    case 'EXITING':
      return { header: 'TURNTRANSLATE', body: 'Closing…', footer: '' };
  }
}

/** Failures where nothing usable was recognized from the audio. */
const SPEECH_FAILURE_CODES = new Set([
  'NO_SPEECH_DETECTED',
  'TRANSCRIPTION_FAILED',
  'UTTERANCE_TOO_SHORT',
]);

function buildErrorModel(input: DisplayInput): DisplayModel {
  const retryable = input.error?.retryable ?? false;
  const footer = retryable ? 'R1: retry' : 'R1: continue';

  // Translation failed after a successful transcription: keep the recognized
  // sentence on screen so the user sees what would have been translated.
  if (input.currentTranscript !== null) {
    return {
      header: 'TRANSLATION ERROR',
      body: `${toDisplayText(input.currentTranscript, BODY_BUDGETS.pendingTranscript)}\n\nTranslation unavailable`,
      footer,
    };
  }

  if (input.error && SPEECH_FAILURE_CODES.has(input.error.code)) {
    return {
      header: 'COULDN’T HEAR',
      body: 'Speech was not understood',
      footer,
    };
  }

  return {
    header: errorTitle(input.error),
    body: input.error?.message ?? 'Something went wrong',
    footer,
  };
}

function errorTitle(error: UserFacingError | null): string {
  switch (error?.code) {
    case 'MIC_PERMISSION_DENIED':
      return 'MICROPHONE ERROR';
    case 'TIMEOUT':
    case 'BACKEND_OFFLINE':
    case 'NETWORK_ERROR':
      return 'CONNECTION ERROR';
    case 'TRANSLATION_FAILED':
      return 'TRANSLATION ERROR';
    default:
      return 'ERROR';
  }
}
