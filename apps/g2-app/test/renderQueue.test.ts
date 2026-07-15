/**
 * RenderQueue tests with delayed asynchronous bridge writes.
 *
 * The queue must treat header/body/footer as one versioned display model:
 * writes never overlap, identical models are never re-sent, obsolete pending
 * models are dropped, and once the final completed model is queued no older
 * Listening/Processing/Translating screen can appear afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderModel, RenderTarget } from '../src/even/renderQueue';
import { RenderQueue } from '../src/even/renderQueue';

const DEBOUNCE_MS = 120;

const HEADER = 1;
const BODY = 2;
const FOOTER = 3;

const model = (header: string, body: string, footer: string): RenderModel =>
  new Map([
    [HEADER, header],
    [BODY, body],
    [FOOTER, footer],
  ]);

// The four screens of one incoming utterance, in pipeline order.
const LISTENING = model('THEM', 'Listening…', 'R1: your turn');
const PROCESSING = model('THEM', 'Processing speech…', 'Please wait');
const TRANSLATING = model(
  'THEY SAID',
  'ich habe gestern mit meinem Onkel über deine Klausur gesprochen!\n\nTranslating…',
  '',
);
const FINAL = model(
  'THEY SAID',
  'ich habe gestern mit meinem Onkel über deine Klausur gesprochen!\n\n→ Yesterday I talked to my uncle about your exam!',
  'R1: your turn',
);

interface WriteRecord {
  containerId: number;
  content: string;
}

/**
 * Bridge stand-in whose writes complete asynchronously. In `auto` mode each
 * write resolves after `delayMs` of (fake) timer time; in manual mode each
 * write stays in flight until `releaseNext()` is called.
 */
class MockTarget implements RenderTarget {
  writes: WriteRecord[] = [];
  active = 0;
  maxConcurrent = 0;
  private pendingReleases: Array<() => void> = [];

  constructor(
    private readonly auto: boolean,
    private readonly delayMs = 5,
  ) {}

  write(containerId: number, content: string): Promise<void> {
    this.writes.push({ containerId, content });
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    return new Promise<void>((resolve) => {
      const complete = (): void => {
        this.active -= 1;
        resolve();
      };
      if (this.auto) {
        setTimeout(complete, this.delayMs);
      } else {
        this.pendingReleases.push(complete);
      }
    });
  }

  releaseNext(): void {
    this.pendingReleases.shift()?.();
  }

  get inFlight(): number {
    return this.pendingReleases.length;
  }

  contentsWritten(): string[] {
    return this.writes.map((write) => write.content);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('write serialization', () => {
  it('never overlaps bridge writes, even when models arrive mid-write', async () => {
    const target = new MockTarget(true, 20);
    const queue = new RenderQueue(target, DEBOUNCE_MS);

    queue.enqueue(LISTENING);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 5); // first write in flight

    queue.enqueue(PROCESSING); // arrives while a write is still pending
    await vi.advanceTimersByTimeAsync(1000);
    await queue.settle();

    expect(target.maxConcurrent).toBe(1);
    queue.dispose();
  });
});

describe('deduplication', () => {
  it('does not re-send an identical display model', async () => {
    const target = new MockTarget(true);
    const queue = new RenderQueue(target, DEBOUNCE_MS);

    queue.enqueue(FINAL);
    await vi.advanceTimersByTimeAsync(1000);
    await queue.settle();
    expect(target.writes).toHaveLength(3);

    queue.enqueue(model('THEY SAID', FINAL.get(BODY)!, 'R1: your turn'));
    await vi.advanceTimersByTimeAsync(1000);
    await queue.settle();
    expect(target.writes).toHaveLength(3); // Nothing new was written.
    queue.dispose();
  });

  it('rewrites only the containers whose content actually changed', async () => {
    const target = new MockTarget(true);
    const queue = new RenderQueue(target, DEBOUNCE_MS);

    queue.enqueue(LISTENING);
    await vi.advanceTimersByTimeAsync(1000);
    await queue.settle();
    expect(target.writes).toHaveLength(3);

    // Same header as LISTENING: only body and footer differ.
    queue.enqueue(PROCESSING);
    await vi.advanceTimersByTimeAsync(1000);
    await queue.settle();
    expect(target.writes).toHaveLength(5);
    expect(target.writes.slice(3).map((write) => write.containerId)).toEqual([BODY, FOOTER]);
    queue.dispose();
  });
});

describe('obsolete model coalescing', () => {
  it('drops obsolete pending models: only the newest queued model is written', async () => {
    const target = new MockTarget(true);
    const queue = new RenderQueue(target, DEBOUNCE_MS);

    // All four screens land within one debounce window.
    queue.enqueue(LISTENING);
    queue.enqueue(PROCESSING);
    queue.enqueue(TRANSLATING);
    queue.enqueue(FINAL);
    await vi.advanceTimersByTimeAsync(1000);
    await queue.settle();

    expect(target.writes).toHaveLength(3);
    expect(target.contentsWritten()).toEqual([
      FINAL.get(HEADER),
      FINAL.get(BODY),
      FINAL.get(FOOTER),
    ]);
    queue.dispose();
  });

  it('an older model abandoned mid-write never overwrites the final result', async () => {
    const target = new MockTarget(false); // Writes complete only on releaseNext().
    const queue = new RenderQueue(target, DEBOUNCE_MS);

    queue.enqueue(PROCESSING);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 5);
    expect(target.writes).toHaveLength(1); // PROCESSING header write in flight.

    // The final model is queued while the old write is still pending.
    queue.enqueue(FINAL);
    target.releaseNext(); // Old write completes; the old model must now be abandoned.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 5);

    // Release everything the final model writes (guarded against hangs).
    for (let guard = 0; target.inFlight > 0 && guard < 10; guard += 1) {
      target.releaseNext();
      await vi.advanceTimersByTimeAsync(1);
    }
    await queue.settle();

    // After the first FINAL-only content appears, no PROCESSING content follows.
    const contents = target.contentsWritten();
    const firstFinalIndex = contents.indexOf(FINAL.get(BODY)!);
    expect(firstFinalIndex).toBeGreaterThan(-1);
    for (const content of contents.slice(firstFinalIndex)) {
      expect(content).not.toBe(PROCESSING.get(BODY));
      expect(content).not.toBe(PROCESSING.get(FOOTER));
    }
    // The last content written per container is exactly the final model.
    const lastPerContainer = new Map<number, string>();
    for (const write of target.writes) lastPerContainer.set(write.containerId, write.content);
    expect(lastPerContainer.get(HEADER)).toBe(FINAL.get(HEADER));
    expect(lastPerContainer.get(BODY)).toBe(FINAL.get(BODY));
    expect(lastPerContainer.get(FOOTER)).toBe(FINAL.get(FOOTER));
    queue.dispose();
  });
});

describe('final result stability', () => {
  it('the final model stays untouched until an explicit new state model arrives', async () => {
    const target = new MockTarget(true);
    const queue = new RenderQueue(target, DEBOUNCE_MS);

    queue.enqueue(FINAL);
    await vi.advanceTimersByTimeAsync(1000);
    await queue.settle();
    const writesAfterFinal = target.writes.length;

    // No timer inside the queue produces further writes, however long we wait.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await queue.settle();
    expect(target.writes).toHaveLength(writesAfterFinal);

    // Only an explicit state change (R1 → listening to me) writes again.
    const listeningToMe = model('YOUR TURN', 'Listening…', 'R1: cancel');
    queue.enqueue(listeningToMe);
    await vi.advanceTimersByTimeAsync(1000);
    await queue.settle();
    expect(target.writes.length).toBeGreaterThan(writesAfterFinal);
    const lastThree = target.contentsWritten().slice(-3);
    expect(lastThree).toEqual(['YOUR TURN', 'Listening…', 'R1: cancel']);
    queue.dispose();
  });

  it('ignores enqueues after dispose', async () => {
    const target = new MockTarget(true);
    const queue = new RenderQueue(target, DEBOUNCE_MS);
    queue.dispose();
    queue.enqueue(FINAL);
    await vi.advanceTimersByTimeAsync(1000);
    expect(target.writes).toHaveLength(0);
  });
});
