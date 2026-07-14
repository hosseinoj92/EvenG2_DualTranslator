/**
 * PCM plumbing for the VAD: fixed-size re-framing of arbitrary BLE chunks,
 * a byte-capped pre-roll ring buffer, and RMS measurement.
 * All PCM here is s16le mono as delivered by the G2 microphone.
 */

/** Concatenates chunks into one contiguous buffer. */
export function concatPcm(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Normalized RMS energy of an s16le frame in 0..1 (1.0 = full scale).
 * A trailing odd byte (should not happen with s16le, but BLE fragmentation is
 * not guaranteed) is ignored.
 */
export function rmsOfPcm16(frame: Uint8Array): number {
  const sampleCount = Math.floor(frame.length / 2);
  if (sampleCount === 0) return 0;
  const view = new DataView(frame.buffer, frame.byteOffset, sampleCount * 2);
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

/**
 * Re-frames arbitrarily sized incoming chunks into fixed-size analysis frames
 * so the VAD's timing math is deterministic regardless of BLE chunking.
 */
export class FrameSlicer {
  private pending: Uint8Array = new Uint8Array(0);

  constructor(private readonly frameBytes: number) {
    if (frameBytes <= 0) throw new Error('frameBytes must be positive');
  }

  push(chunk: Uint8Array): Uint8Array[] {
    const combined = this.pending.length === 0 ? chunk : concatPcm([this.pending, chunk]);
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (combined.length - offset >= this.frameBytes) {
      // Copy so frames stay valid after the source buffer is reused.
      frames.push(combined.slice(offset, offset + this.frameBytes));
      offset += this.frameBytes;
    }
    this.pending = combined.slice(offset);
    return frames;
  }

  reset(): void {
    this.pending = new Uint8Array(0);
  }
}

/**
 * Ring buffer holding the most recent `capacityBytes` of audio. Drained into
 * the utterance when speech starts so the first syllables are not lost.
 */
export class PreRollBuffer {
  private frames: Uint8Array[] = [];
  private storedBytes = 0;

  constructor(private readonly capacityBytes: number) {
    if (capacityBytes < 0) throw new Error('capacityBytes must be >= 0');
  }

  push(frame: Uint8Array): void {
    this.frames.push(frame);
    this.storedBytes += frame.length;
    while (this.storedBytes > this.capacityBytes && this.frames.length > 0) {
      const evicted = this.frames.shift();
      if (evicted) this.storedBytes -= evicted.length;
    }
  }

  drain(): Uint8Array {
    const audio = concatPcm(this.frames);
    this.clear();
    return audio;
  }

  clear(): void {
    this.frames = [];
    this.storedBytes = 0;
  }

  get byteLength(): number {
    return this.storedBytes;
  }
}
