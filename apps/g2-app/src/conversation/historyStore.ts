/**
 * Pure helpers for the in-memory conversation history. History lives inside
 * the state machine's context; these functions keep list manipulation and
 * browsing math testable in isolation. Nothing here is ever persisted or sent
 * to the backend — every translation request is independent.
 */

import type { ConversationTurn } from '../types';

/** Appends a turn, evicting the oldest entries beyond `maxItems`. */
export function appendTurn(
  history: readonly ConversationTurn[],
  turn: ConversationTurn,
  maxItems: number,
): ConversationTurn[] {
  const next = [...history, turn];
  return next.length > maxItems ? next.slice(next.length - maxItems) : next;
}

/** Latest turn, or null when the conversation has not produced one yet. */
export function latestTurn(history: readonly ConversationTurn[]): ConversationTurn | null {
  return history.length > 0 ? (history[history.length - 1] ?? null) : null;
}

/**
 * Index to start browsing from: the most recent item. Returns null when there
 * is nothing to browse.
 */
export function startBrowsingIndex(history: readonly ConversationTurn[]): number | null {
  return history.length > 0 ? history.length - 1 : null;
}

/** Move one step towards older items; clamps at the oldest entry. */
export function previousIndex(current: number): number {
  return Math.max(0, current - 1);
}

/**
 * Move one step towards newer items. Returns null when stepping past the
 * newest item — the caller then leaves browsing and returns to live state.
 */
export function nextIndex(current: number, historyLength: number): number | null {
  const candidate = current + 1;
  return candidate >= historyLength ? null : candidate;
}

/** `HISTORY · 3 / 8`-style indicator for the glasses header. */
export function historyIndicator(index: number, historyLength: number): string {
  return `HISTORY · ${index + 1} / ${historyLength}`;
}
