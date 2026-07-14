/**
 * Glasses-microphone control. Wraps bridge.audioControl with state tracking
 * so redundant BLE round-trips are skipped, and converts a refused open into
 * a typed error (the host returns `false` when the mic permission is missing
 * or the startup page has not been created yet).
 */

import { AudioInputSource } from '@evenrealities/even_hub_sdk';
import type { EvenBridge } from '../even/bridge';

export class MicrophoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrophoneError';
  }
}

export class MicrophoneController {
  private open = false;
  private pending: Promise<void> | null = null;

  constructor(private readonly bridge: EvenBridge) {}

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Opens or closes the glasses microphone. Serialized so overlapping state
   * transitions cannot interleave their bridge calls.
   */
  async setOpen(open: boolean): Promise<void> {
    const previous = this.pending ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // A failed previous transition must not wedge the queue.
      })
      .then(async () => {
        if (this.open === open) return;
        const ok = await this.bridge.audioControl(open, AudioInputSource.Glasses);
        if (!ok && open) {
          throw new MicrophoneError(
            'The glasses microphone could not be opened. Check the g2-microphone permission.',
          );
        }
        this.open = open;
      });
    this.pending = next;
    return next;
  }

  /** Best-effort close used during cleanup paths. Never throws. */
  async closeQuietly(): Promise<void> {
    try {
      await this.setOpen(false);
    } catch {
      // Ignore: we are tearing down.
    }
  }
}
