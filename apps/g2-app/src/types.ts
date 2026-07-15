/**
 * Frontend-only types. Wire contracts live in @turntranslate/shared;
 * everything here describes in-app state, never the network.
 */

import type { ConversationDirection, LanguageCode } from '@turntranslate/shared';
import type { ConversationStatus, ProcessingPhase } from './conversation/conversationMachine';

/** One completed translation turn kept in local history. */
export interface ConversationTurn {
  id: string;
  direction: ConversationDirection;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  transcript: string;
  translation: string;
  /** Epoch milliseconds. */
  timestamp: number;
}

export interface LanguageSettings {
  myLanguage: LanguageCode;
  otherLanguage: LanguageCode;
}

/** Live VAD diagnostics shown only in the phone debug panel, never on glasses. */
export interface VadDebugInfo {
  rms: number;
  speaking: boolean;
  state: 'idle' | 'maybe-speech' | 'recording';
}

export interface UserFacingError {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Snapshot pushed to the companion UI after every change. The UI renders it
 * verbatim; it holds no state of its own.
 */
export interface AppSnapshot {
  status: ConversationStatus;
  direction: ConversationDirection;
  settings: LanguageSettings;
  conversationActive: boolean;
  bridgeConnected: boolean;
  online: boolean;
  micOpen: boolean;
  speechActive: boolean;
  /** Stage of the two-stage pipeline for the utterance being processed. */
  processingPhase: ProcessingPhase;
  /**
   * Completed transcript of the utterance currently being processed
   * (transcription finished, translation pending or failed); null otherwise.
   */
  currentTranscript: string | null;
  /** Live preview of the sentence still being spoken (best effort). */
  partialTranscript: string | null;
  /** Live preview translation of `partialTranscript` (best effort). */
  partialTranslation: string | null;
  history: ConversationTurn[];
  historyIndex: number | null;
  latestTurn: ConversationTurn | null;
  /** The turn currently shown while browsing history; null when live. */
  browsingTurn: ConversationTurn | null;
  error: UserFacingError | null;
  vad: VadDebugInfo;
  lastLatencyMs: number | null;
  backendUrl: string;
}

/** What the three glasses containers should currently show. */
export interface DisplayModel {
  header: string;
  body: string;
  footer: string;
}
