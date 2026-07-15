/**
 * Serialized, debounced writer for glasses display updates.
 *
 * The queue operates on whole display models — header, body and footer as one
 * logical unit — never on independently mixed containers from different
 * application states.
 *
 * Guarantees:
 *   - Only one bridge write is in flight at any time (BLE cannot interleave).
 *   - Rapid successive models are coalesced: only the newest pending model is
 *     written after the debounce window; obsolete pending models are dropped.
 *   - Once a newer model is enqueued, no further container writes from an
 *     older model are issued, so an old Listening/Processing/Translating
 *     screen can never overwrite a completed final result.
 *   - Content identical to what a container already shows is never re-sent.
 */

export interface RenderTarget {
  /** Performs the actual write for one container. */
  write(containerId: number, content: string): Promise<void>;
}

/** One complete display model: content per container ID. */
export type RenderModel = ReadonlyMap<number, string>;

export class RenderQueue {
  /** The single newest model waiting to be written; older ones are discarded. */
  private pending: RenderModel | null = null;
  private readonly lastWritten = new Map<number, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly target: RenderTarget,
    private readonly debounceMs: number,
    private readonly onError?: (error: unknown) => void,
  ) {}

  /**
   * Queues one complete display model. A model enqueued later always
   * supersedes any model still waiting to be written.
   */
  enqueue(model: RenderModel): void {
    if (this.disposed) return;
    this.pending = model;
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.debounceMs);
    }
  }

  /** Serialized flush of the newest pending model. */
  private flush(): void {
    this.flushing = this.flushing.then(async () => {
      // Taken at flush time, so everything enqueued while an earlier flush
      // was writing collapses into the single newest model.
      const model = this.pending;
      this.pending = null;
      if (model === null) return;
      for (const [containerId, content] of model) {
        if (this.disposed) return;
        // A newer model arrived while this one was being written: abandon
        // the rest. The newer model's own flush is chained behind this one
        // and brings every container up to date.
        if (this.pending !== null) return;
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
    this.pending = null;
  }
}
