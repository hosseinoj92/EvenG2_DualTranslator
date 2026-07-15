/**
 * Application entry point. Mounts the phone UI immediately, then tries to
 * acquire the Even App bridge. Without a bridge (plain browser during
 * development) the app degrades to phone-only mode: manual translation and
 * settings still work, glasses rendering and the microphone do not.
 */

import './ui/styles.css';
import { isSupportedLanguageCode } from '@turntranslate/shared';
import { appConfig } from './config';
import { createTranslationClient } from './api/translationClient';
import { MicrophoneController } from './audio/audioCapture';
import { ConversationController } from './conversation/conversationController';
import type { EvenBridge } from './even/bridge';
import { BridgeUnavailableError, connectToBridge } from './even/bridge';
import { DisplayManager } from './even/displayManager';
import { buildDisplayModel } from './even/displayModel';
import { acceptAnyClickPolicy, subscribeToEvenHubEvents } from './even/eventRouter';
import { mountCompanionUi } from './ui/companionUi';
import {
  createBridgeSettingsBackend,
  createBrowserSettingsBackend,
  loadLanguageSettings,
  saveLanguageSettings,
} from './utils/settingsStore';
import type { AppSnapshot } from './types';

async function start(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) throw new Error('#app root element missing');

  // 1. Bridge (or phone-only fallback).
  let bridge: EvenBridge | null = null;
  try {
    bridge = await connectToBridge(appConfig.bridge.connectTimeoutMs);
  } catch (error) {
    if (error instanceof BridgeUnavailableError && import.meta.env.DEV) {
      console.warn('[turntranslate] Even App bridge unavailable — phone-only dev mode.');
    }
  }

  // 2. Settings (bridge storage inside Even App, localStorage elsewhere).
  const settingsBackend = bridge
    ? createBridgeSettingsBackend(bridge)
    : createBrowserSettingsBackend();
  const settings = await loadLanguageSettings(settingsBackend);

  // 3. Glasses display.
  let display: DisplayManager | null = null;
  const controller = new ConversationController({
    config: appConfig,
    client: createTranslationClient({
      baseUrl: appConfig.api.baseUrl,
      timeoutMs: appConfig.api.requestTimeoutMs,
    }),
    microphone: bridge ? new MicrophoneController(bridge) : null,
    settings,
    onSettingsChanged: (next) => {
      void saveLanguageSettings(settingsBackend, next);
    },
    onShutdown: () => cleanup(),
  });

  const toDisplayInput = (snapshot: AppSnapshot) => ({
    status: snapshot.status,
    direction: snapshot.direction,
    processingPhase: snapshot.processingPhase,
    currentTranscript: snapshot.currentTranscript,
    settings: snapshot.settings,
    latestTurn: snapshot.latestTurn,
    browsingTurn: snapshot.browsingTurn,
    historyIndex: snapshot.historyIndex,
    historyLength: snapshot.history.length,
    error: snapshot.error,
  });

  if (bridge) {
    display = new DisplayManager(bridge, appConfig, (error) => {
      if (import.meta.env.DEV) console.error('[turntranslate] display write failed:', error);
    });
    try {
      await display.initialize(buildDisplayModel(toDisplayInput(controller.snapshot())));
    } catch (error) {
      // Without containers there is no glasses UI, but the phone UI still works.
      if (import.meta.env.DEV) console.error('[turntranslate] display init failed:', error);
      display.dispose();
      display = null;
    }
  }

  // 4. Phone companion UI.
  const ui = mountCompanionUi(root, {
    onStartConversation: () => controller.startConversation(),
    onEndConversation: () => controller.endConversation(),
    onToggleDirection: () => controller.toggleDirection(),
    onSwapLanguages: () => controller.swapLanguages(),
    onSelectMyLanguage: (code) => {
      if (isSupportedLanguageCode(code)) {
        controller.updateSettings({ ...controller.snapshot().settings, myLanguage: code });
      }
    },
    onSelectOtherLanguage: (code) => {
      if (isSupportedLanguageCode(code)) {
        controller.updateSettings({ ...controller.snapshot().settings, otherLanguage: code });
      }
    },
    onManualTranslate: (text, direction) => controller.submitManualText(text, direction),
    onRetry: () => controller.retry(),
  });

  // 5. Every state change fans out to both surfaces.
  const unsubscribeSnapshots = controller.subscribe((snapshot) => {
    ui.update(snapshot);
    display?.show(buildDisplayModel(toDisplayInput(snapshot)));
  });

  // 6. Glasses input events.
  let unsubscribeBridge: (() => void) | null = null;
  if (bridge) {
    const boundBridge = bridge;
    unsubscribeBridge = subscribeToEvenHubEvents(
      boundBridge,
      {
        onClick: () => controller.handleGlassesClick(),
        onDoubleClick: () => {
          // Exit mode 1: the OS shows its confirmation layer; SYSTEM_EXIT_EVENT
          // arrives if the user confirms, and cleanup happens there.
          void boundBridge.shutDownPageContainer(1);
        },
        onSwipeUp: () => controller.historyPrevious(),
        onSwipeDown: () => controller.historyNext(),
        onSystemExit: () => {
          controller.requestExit();
        },
        onAudioFrame: (pcm) => controller.handleAudioFrame(pcm),
      },
      acceptAnyClickPolicy,
    );
  }

  // 7. Connectivity.
  const onOnline = () => controller.setNetworkOnline(true);
  const onOffline = () => controller.setNetworkOnline(false);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  if (!navigator.onLine) controller.setNetworkOnline(false);

  // 8. Cleanup: stop capture, cancel requests, clear timers, unsubscribe,
  //    release buffered audio. Idempotent — reachable from SYSTEM_EXIT_EVENT,
  //    ABNORMAL_EXIT_EVENT (via requestExit) and beforeunload.
  let cleanedUp = false;
  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    unsubscribeBridge?.();
    unsubscribeSnapshots();
    controller.dispose();
    display?.dispose();
    void bridge?.audioControl(false);
  }
  window.addEventListener('beforeunload', cleanup);
}

void start().catch((error: unknown) => {
  console.error('[turntranslate] fatal startup error:', error);
  const root = document.querySelector<HTMLDivElement>('#app');
  if (root) {
    const message = document.createElement('p');
    message.style.cssText = 'color:#ff7a76;font-family:sans-serif;padding:16px;';
    message.textContent = 'TurnTranslate failed to start. Close and reopen the app.';
    root.replaceChildren(message);
  }
});
