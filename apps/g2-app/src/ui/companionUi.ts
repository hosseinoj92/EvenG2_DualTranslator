/**
 * Companion phone UI. Framework-free: DOM nodes are built once with
 * document.createElement and mutated via textContent on every snapshot —
 * conversation text (transcripts, translations, errors) never travels through
 * innerHTML, so untrusted model output cannot inject markup.
 */

import type { ConversationDirection } from '@turntranslate/shared';
import { SUPPORTED_LANGUAGES, getLanguage } from '@turntranslate/shared';
import type { AppSnapshot, ConversationTurn } from '../types';

export interface CompanionUiCallbacks {
  onStartConversation(): void;
  onEndConversation(): void;
  onToggleDirection(): void;
  onSwapLanguages(): void;
  onSelectMyLanguage(code: string): void;
  onSelectOtherLanguage(code: string): void;
  onManualTranslate(text: string, direction: ConversationDirection): void;
  onRetry(): void;
}

export interface CompanionUi {
  update(snapshot: AppSnapshot): void;
}

export function mountCompanionUi(root: HTMLElement, callbacks: CompanionUiCallbacks): CompanionUi {
  root.replaceChildren();
  const app = el('div', 'tt-app');
  root.append(app);

  // ----- title + status chips ---------------------------------------------
  const titlebar = el('header', 'tt-titlebar');
  const title = el('h1');
  title.textContent = 'TurnTranslate';
  const chips = el('div', 'tt-status-chips');
  const chipBridge = chip('Glasses');
  const chipNetwork = chip('Network');
  const chipMic = chip('Mic');
  chips.append(chipBridge, chipNetwork, chipMic);
  titlebar.append(title, chips);

  // ----- conversation panel ------------------------------------------------
  const convPanel = el('section', 'tt-panel');
  convPanel.append(heading('Conversation'));
  const directionLine = el('div', 'tt-direction');
  const stateLine = el('div', 'tt-error');
  stateLine.setAttribute('role', 'status');

  const toggleButton = button('Switch speaker', 'primary big');
  toggleButton.addEventListener('click', () => callbacks.onToggleDirection());

  const startEndRow = el('div', 'tt-row');
  const startButton = button('Start conversation', 'primary grow');
  startButton.addEventListener('click', () => callbacks.onStartConversation());
  const endButton = button('End conversation', 'danger grow');
  endButton.addEventListener('click', () => callbacks.onEndConversation());
  const retryButton = button('Retry', 'grow');
  retryButton.addEventListener('click', () => callbacks.onRetry());
  startEndRow.append(startButton, endButton, retryButton);

  convPanel.append(directionLine, toggleButton, startEndRow, stateLine);

  // ----- languages panel ----------------------------------------------------
  const langPanel = el('section', 'tt-panel');
  langPanel.append(heading('Languages'));
  const langRow = el('div', 'tt-row');
  const mySelect = languageSelect('My language');
  const otherSelect = languageSelect("Other person's language");
  mySelect.select.addEventListener('change', () =>
    callbacks.onSelectMyLanguage(mySelect.select.value),
  );
  otherSelect.select.addEventListener('change', () =>
    callbacks.onSelectOtherLanguage(otherSelect.select.value),
  );
  const swapButton = button('⇄ Swap');
  swapButton.setAttribute('aria-label', 'Swap languages');
  swapButton.addEventListener('click', () => callbacks.onSwapLanguages());
  langRow.append(mySelect.field, otherSelect.field, swapButton);
  langPanel.append(langRow);

  // ----- latest result panel -------------------------------------------------
  const resultPanel = el('section', 'tt-panel tt-transcript');
  resultPanel.append(heading('Latest translation'));
  const sourceText = el('p', 'src');
  const translatedText = el('p', 'dst');
  resultPanel.append(sourceText, translatedText);

  // ----- manual input panel ---------------------------------------------------
  const manualPanel = el('section', 'tt-panel');
  manualPanel.append(heading('Type instead of speaking'));
  const manualInput = document.createElement('textarea');
  manualInput.placeholder = 'Type text to translate…';
  manualInput.setAttribute('aria-label', 'Text to translate');
  const manualRow = el('div', 'tt-row');
  const manualMeButton = button('Translate for them', 'grow');
  manualMeButton.addEventListener('click', () => {
    callbacks.onManualTranslate(manualInput.value, 'me-to-them');
    manualInput.value = '';
  });
  const manualThemButton = button('Translate what they wrote', 'grow');
  manualThemButton.addEventListener('click', () => {
    callbacks.onManualTranslate(manualInput.value, 'them-to-me');
    manualInput.value = '';
  });
  manualRow.append(manualMeButton, manualThemButton);
  manualPanel.append(manualInput, manualRow);

  // ----- history panel ----------------------------------------------------------
  const historyPanel = el('section', 'tt-panel');
  historyPanel.append(heading('History'));
  const historyList = el('ul', 'tt-history');
  const historyEmpty = el('div', 'tt-empty');
  historyEmpty.textContent = 'No translations yet';
  historyPanel.append(historyEmpty, historyList);

  // ----- diagnostics -------------------------------------------------------------
  const diagnostics = document.createElement('details');
  diagnostics.className = 'tt-diagnostics';
  const diagSummary = document.createElement('summary');
  diagSummary.textContent = 'Diagnostics';
  const diagGrid = el('div', 'tt-diag-grid');
  const diagRows = {
    state: diagRow(diagGrid, 'state'),
    rms: diagRow(diagGrid, 'vad rms'),
    vad: diagRow(diagGrid, 'vad'),
    latency: diagRow(diagGrid, 'latency'),
    backend: diagRow(diagGrid, 'backend'),
  };
  diagnostics.append(diagSummary, diagGrid);

  app.append(titlebar, convPanel, langPanel, resultPanel, manualPanel, historyPanel, diagnostics);

  // ----- update -------------------------------------------------------------------
  let lastHistoryStamp = '';

  function update(snapshot: AppSnapshot): void {
    setChip(
      chipBridge,
      snapshot.bridgeConnected ? 'Glasses ✓' : 'No glasses',
      snapshot.bridgeConnected,
    );
    setChip(chipNetwork, snapshot.online ? 'Online' : 'Offline', snapshot.online);
    setChip(chipMic, snapshot.micOpen ? 'Mic live' : 'Mic off', snapshot.micOpen);

    directionLine.textContent = describeDirection(snapshot);
    stateLine.textContent = snapshot.error ? snapshot.error.message : statusHint(snapshot);

    const busy = snapshot.status === 'PROCESSING_THEM' || snapshot.status === 'PROCESSING_ME';
    startButton.disabled = snapshot.conversationActive || snapshot.status === 'EXITING';
    endButton.disabled = !snapshot.conversationActive;
    toggleButton.disabled =
      !snapshot.conversationActive ||
      snapshot.status === 'OFFLINE' ||
      snapshot.status === 'EXITING';
    retryButton.disabled = !(snapshot.status === 'ERROR' && (snapshot.error?.retryable ?? false));
    manualMeButton.disabled = busy || !snapshot.online;
    manualThemButton.disabled = busy || !snapshot.online;

    mySelect.select.value = snapshot.settings.myLanguage;
    otherSelect.select.value = snapshot.settings.otherLanguage;

    const shown = snapshot.browsingTurn ?? snapshot.latestTurn;
    sourceText.textContent = shown ? shown.transcript : '—';
    translatedText.textContent = shown ? shown.translation : '—';

    renderHistory(snapshot);

    diagRows.state.textContent = snapshot.status;
    diagRows.rms.textContent = snapshot.vad.rms.toFixed(4);
    diagRows.vad.textContent = snapshot.vad.speaking
      ? `active (${snapshot.vad.state})`
      : snapshot.vad.state;
    diagRows.latency.textContent =
      snapshot.lastLatencyMs === null ? '—' : `${snapshot.lastLatencyMs} ms`;
    diagRows.backend.textContent = `${snapshot.backendUrl} (${snapshot.online ? 'reachable?' : 'offline'})`;
  }

  function renderHistory(snapshot: AppSnapshot): void {
    // Rebuild only when content or highlight changed; cheap enough at ≤20 items.
    const stamp =
      snapshot.history.map((turn) => turn.id).join('|') + `#${snapshot.historyIndex ?? -1}`;
    if (stamp === lastHistoryStamp) return;
    lastHistoryStamp = stamp;

    historyEmpty.style.display = snapshot.history.length === 0 ? '' : 'none';
    historyList.replaceChildren(
      ...[...snapshot.history]
        .reverse()
        .map((turn, reverseIndex) =>
          historyItem(
            turn,
            snapshot.historyIndex !== null &&
              snapshot.history.length - 1 - reverseIndex === snapshot.historyIndex,
          ),
        ),
    );
  }

  return { update };
}

// ----- tiny DOM helpers -----------------------------------------------------

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function heading(text: string): HTMLElement {
  const node = el('h2');
  node.textContent = text;
  return node;
}

function chip(text: string): HTMLElement {
  const node = el('span', 'tt-chip');
  node.textContent = text;
  return node;
}

function setChip(node: HTMLElement, text: string, good: boolean): void {
  node.textContent = text;
  node.dataset.tone = good ? 'good' : 'bad';
}

function button(label: string, className = ''): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  return node;
}

function languageSelect(labelText: string): { field: HTMLLabelElement; select: HTMLSelectElement } {
  const field = document.createElement('label');
  field.className = 'tt-field';
  const caption = document.createElement('span');
  caption.textContent = labelText;
  const select = document.createElement('select');
  for (const language of SUPPORTED_LANGUAGES) {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = `${language.name} (${language.shortLabel})`;
    select.append(option);
  }
  field.append(caption, select);
  return { field, select };
}

function diagRow(grid: HTMLElement, label: string): HTMLElement {
  const key = el('span');
  key.textContent = label;
  const value = el('span');
  value.textContent = '—';
  grid.append(key, value);
  return value;
}

function historyItem(turn: ConversationTurn, active: boolean): HTMLElement {
  const item = el('li');
  if (active) item.classList.add('active');
  const meta = el('div', 'meta');
  const source = getLanguage(turn.sourceLanguage).shortLabel;
  const target = getLanguage(turn.targetLanguage).shortLabel;
  const who = turn.direction === 'them-to-me' ? 'THEM' : 'YOU';
  meta.textContent = `${who} · ${source} → ${target} · ${new Date(turn.timestamp).toLocaleTimeString()}`;
  const src = el('p', 'line src');
  src.textContent = turn.transcript;
  const dst = el('p', 'line dst');
  dst.textContent = turn.translation;
  item.append(meta, src, dst);
  return item;
}

function describeDirection(snapshot: AppSnapshot): string {
  const my = getLanguage(snapshot.settings.myLanguage);
  const other = getLanguage(snapshot.settings.otherLanguage);
  if (snapshot.direction === 'them-to-me') {
    return `THEM · ${other.name} → ${my.name}`;
  }
  return `YOU · ${my.name} → ${other.name}`;
}

function statusHint(snapshot: AppSnapshot): string {
  switch (snapshot.status) {
    case 'SETUP':
      return 'Press “Start conversation”, then hand the first word to the other person.';
    case 'LISTENING_TO_THEM':
      return snapshot.speechActive ? 'Hearing them…' : 'Listening for the other person…';
    case 'LISTENING_TO_ME':
      return snapshot.speechActive ? 'Hearing you…' : 'Speak now — your words will be translated.';
    case 'PROCESSING_THEM':
    case 'PROCESSING_ME':
      return 'Translating…';
    case 'SHOWING_THEM_RESULT':
      return 'Translation shown on the glasses.';
    case 'READ_ALOUD_PAUSED':
      return 'Read the translation on the glasses aloud, then switch back.';
    case 'BROWSING_HISTORY':
      return 'Browsing history on the glasses.';
    case 'OFFLINE':
      return 'Offline — translations resume when the connection returns.';
    case 'ERROR':
      return '';
    case 'EXITING':
      return 'Closing…';
  }
}
