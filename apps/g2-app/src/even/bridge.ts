/**
 * Bridge acquisition. `waitForEvenAppBridge` never rejects — outside the Even
 * App WebView it simply never resolves — so a timeout converts that hang into
 * a typed error and the app can degrade to phone-only mode (companion UI +
 * manual translation, no glasses/microphone).
 */

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';

/** The subset of the SDK bridge this app is allowed to touch. */
export type EvenBridge = Pick<
  EvenAppBridge,
  | 'createStartUpPageContainer'
  | 'textContainerUpgrade'
  | 'audioControl'
  | 'onEvenHubEvent'
  | 'shutDownPageContainer'
  | 'getLocalStorage'
  | 'setLocalStorage'
>;

export class BridgeUnavailableError extends Error {
  constructor(timeoutMs: number) {
    super(`Even App bridge did not become ready within ${timeoutMs} ms`);
    this.name = 'BridgeUnavailableError';
  }
}

export async function connectToBridge(timeoutMs: number): Promise<EvenBridge> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<EvenBridge>([
      waitForEvenAppBridge(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BridgeUnavailableError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
