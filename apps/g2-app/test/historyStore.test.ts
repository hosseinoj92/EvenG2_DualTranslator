import { describe, expect, it } from 'vitest';
import {
  appendTurn,
  historyIndicator,
  latestTurn,
  nextIndex,
  previousIndex,
  startBrowsingIndex,
} from '../src/conversation/historyStore';
import type { ConversationTurn } from '../src/types';

function turn(id: string): ConversationTurn {
  return {
    id,
    direction: 'them-to-me',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    transcript: 's',
    translation: 't',
    timestamp: 0,
  };
}

describe('appendTurn', () => {
  it('appends and evicts beyond the cap', () => {
    let history: ConversationTurn[] = [];
    for (let i = 0; i < 25; i += 1) history = appendTurn(history, turn(`t${i}`), 20);
    expect(history).toHaveLength(20);
    expect(history[0]?.id).toBe('t5');
    expect(history[19]?.id).toBe('t24');
  });

  it('does not mutate its input', () => {
    const original = [turn('a')];
    appendTurn(original, turn('b'), 20);
    expect(original).toHaveLength(1);
  });
});

describe('navigation', () => {
  it('latestTurn and startBrowsingIndex handle empty history', () => {
    expect(latestTurn([])).toBeNull();
    expect(startBrowsingIndex([])).toBeNull();
    const history = [turn('a'), turn('b')];
    expect(latestTurn(history)?.id).toBe('b');
    expect(startBrowsingIndex(history)).toBe(1);
  });

  it('previousIndex clamps at zero', () => {
    expect(previousIndex(3)).toBe(2);
    expect(previousIndex(0)).toBe(0);
  });

  it('nextIndex advances and signals the exit past the newest item', () => {
    expect(nextIndex(0, 3)).toBe(1);
    expect(nextIndex(2, 3)).toBeNull();
  });

  it('renders the HISTORY indicator 1-based', () => {
    expect(historyIndicator(2, 8)).toBe('HISTORY · 3 / 8');
  });
});
