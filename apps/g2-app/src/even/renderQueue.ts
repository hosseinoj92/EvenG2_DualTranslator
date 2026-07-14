/**
 * Serialized, debounced writer for glasses display updates.
 *
 * Guarantees:
 *   - Only one bridge write is in flight at any time (BLE cannot interleave).
 *   - Rapid successive updates are coalesced: only the latest pending payload
 *     per container is written after the debounce window.
 *   - Identical content is never re-sent.
 */

export interface RenderTarget {
  /** Performs the actual write for one container. */
  write(containerId: number, content: string): Promise<void>;
}

export class RenderQueue {
  private readonly pending = new Map<number, string>();
  private readonly lastWritten = new Map<number, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly target: RenderTarget,
    private readonly debounceMs: number,
    private readonly onError?: (error: unknown) => void,
  ) {}

  /** Queues content for a container; actual write happens after the debounce. */
  enqueue(containerId: number, content: string): void {
    if (this.disposed) return;
    this.pending.set(containerId, content);
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.debounceMs);
    }
  }

  /** Serialized flush of all pending container writes. */
  private flush(): void {
    this.flushing = this.flushing.then(async () => {
      const batch = [...this.pending.entries()];
      this.pending.clear();
      for (const [containerId, content] of batch) {
        if (this.disposed) return;
        if (this.lastWritten.get(containerId) === content) continue;
        try {
          await this.target.write(containerId, content);
          this.lastWritten.set(containerId, content);
        } catch (error) {
          // Display write failures must not kill the queue; surface and move on.
          this.onError?.(error);
        }
      }
    });
  }

  /** Resolves when everything queued so far has been written. */
  async settle(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.flush();
    }
    await this.flushing;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }
}
