/**
 * Pure mapping from app state to the three glasses container texts.
 *
 * The layouts are speaker- and task-oriented: each screen answers exactly one
 * question (who is speaking? what did they say? what does it mean? what should
 * I say aloud?). The language pair is chosen during setup, so language codes
 * are never repeated per turn. Listening screens are deliberately static —
 * no partial transcripts or translations ever appear while someone speaks.
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
import { paginateText, sanitizeBlock, toDisplayText } from '../utils/text';

/** Everything the display needs to know about the current app state. */
export interface DisplayInput {
  status: ConversationStatus;
  direction: ConversationDirection;
  processingPhase: ProcessingPhase;
  /** Completed transcript while translation is pending or failed. */
  currentTranscript: string | null;
  settings: LanguageSettings;
  latestTurn: ConversationTurn | null;
  /** Zero-based page of the current result body (swipe to change). */
  bodyPage: number;
  error: UserFacingError | null;
}

/**
 * Character budgets for composed bodies. The body container fits roughly 300
 * characters comfortably.
 */
export const BODY_BUDGETS = {
  /** Transcript shown alone while translation is pending or failed. */
  pendingTranscript: 220,
  /**
   * Page size for completed-result bodies. Result text is never truncated —
   * anything longer than one page is split at word boundaries and read by
   * swiping. Conservative so a page always fits the 204 px body box; the
   * pixel fit in DisplayManager remains as a safety net.
   */
  resultPageChars: 260,
} as const;

/**
 * Completed result (both directions): the recognized sentence and its
 * translation stay together so the user can compare them, split into
 * swipeable pages instead of being truncated. Always at least one page.
 */
export function resultBodyPages(turn: ConversationTurn): string[] {
  const source = sanitizeBlock(turn.transcript);
  const translation = sanitizeBlock(turn.translation);
  return paginateText(`${source}\n\n→ ${translation}`, BODY_BUDGETS.resultPageChars);
}

/** Transcript is in, translation still running (either direction). */
export function composeTranslationPendingBody(transcript: string): string {
  return `${toDisplayText(transcript, BODY_BUDGETS.pendingTranscript)}\n\nTranslating…`;
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
      // Nothing but a stable listening screen while they talk: no partial
      // words, no periodically refreshed text.
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
      return { header: 'THEM', body: 'Processing speech…', footer: 'Please wait' };

    case 'SHOWING_THEM_RESULT':
      // Stays on screen indefinitely; R1 hands over, double-tap keeps the
      // same speaker, swipes page through a long body.
      return resultModel('THEY SAID', input.latestTurn, input.bodyPage, {
        singleSpeakerHint: 'R1: your turn · 2×tap: they continue',
      });

    case 'LISTENING_TO_ME':
      return {
        header: 'YOUR TURN',
        body: 'Listening…',
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
      return { header: 'YOU', body: 'Processing speech…', footer: 'Please wait' };

    case 'READ_ALOUD_PAUSED': {
      // The completed outgoing result shows both texts — the user's original
      // sentence and the translation to read aloud — until R1 is pressed.
      const turn =
        input.latestTurn && input.latestTurn.direction === 'me-to-them' ? input.latestTurn : null;
      return resultModel('YOU SAID', turn, input.bodyPage, {
        singleSpeakerHint: 'R1: their turn · 2×tap: you continue',
      });
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

/**
 * Builds a completed-result screen. Long bodies are paginated: the header
 * gains a `· page/total` indicator plus a swipe hint in the footer, and the
 * requested page is clamped so a stale page index can never point past the
 * end of a shorter body.
 */
function resultModel(
  speakerHeader: string,
  turn: ConversationTurn | null,
  bodyPage: number,
  hints: { singleSpeakerHint: string },
): DisplayModel {
  if (!turn) {
    return { header: speakerHeader, body: '', footer: hints.singleSpeakerHint };
  }
  const pages = resultBodyPages(turn);
  if (pages.length === 1) {
    return { header: speakerHeader, body: pages[0] ?? '', footer: hints.singleSpeakerHint };
  }
  const page = Math.max(0, Math.min(bodyPage, pages.length - 1));
  return {
    header: `${speakerHeader} · ${page + 1}/${pages.length}`,
    body: pages[page] ?? '',
    // Compact so it stays on one line: swiping is the hint that matters here.
    footer: 'Swipe: more · R1: next · 2×tap: same',
  };
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
