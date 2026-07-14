import { describe, expect, it } from 'vitest';
import { FrameSlicer, PreRollBuffer, concatPcm, rmsOfPcm16 } from '../src/audio/pcmBuffer';

describe('FrameSlicer', () => {
  it('re-frames arbitrary chunks into fixed frames', () => {
    const slicer = new FrameSlicer(4);
    expect(slicer.push(new Uint8Array([1, 2]))).toEqual([]);
    const frames = slicer.push(new Uint8Array([3, 4, 5, 6, 7]));
    expect(frames).toHaveLength(1);
    expect([...frames[0]!]).toEqual([1, 2, 3, 4]);
    const more = slicer.push(new Uint8Array([8]));
    expect(more).toHaveLength(1);
    expect([...more[0]!]).toEqual([5, 6, 7, 8]);
  });

  it('reset drops partial data', () => {
    const slicer = new FrameSlicer(4);
    slicer.push(new Uint8Array([1, 2, 3]));
    slicer.reset();
    expect(slicer.push(new Uint8Array([4, 5, 6, 7]))).toHaveLength(1);
  });
});

describe('PreRollBuffer', () => {
  it('keeps only the newest bytes up to capacity', () => {
    const buffer = new PreRollBuffer(6);
    buffer.push(new Uint8Array([1, 1]));
    buffer.push(new Uint8Array([2, 2]));
    buffer.push(new Uint8Array([3, 3]));
    buffer.push(new Uint8Array([4, 4])); // evicts [1,1]
    expect(buffer.byteLength).toBe(6);
    expect([...buffer.drain()]).toEqual([2, 2, 3, 3, 4, 4]);
    expect(buffer.byteLength).toBe(0);
  });
});

describe('concatPcm / rmsOfPcm16', () => {
  it('concatenates in order', () => {
    const joined = concatPcm([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]);
    expect([...joined]).toEqual([1, 2, 3]);
  });

  it('measures silence as zero and full-scale as ~1', () => {
    expect(rmsOfPcm16(new Uint8Array(64))).toBe(0);

    const loud = new Uint8Array(64);
    const view = new DataView(loud.buffer);
    for (let i = 0; i < 32; i += 1) view.setInt16(i * 2, i % 2 === 0 ? 32767 : -32767, true);
    expect(rmsOfPcm16(loud)).toBeCloseTo(1, 2);
  });

  it('tolerates empty and odd-length frames', () => {
    expect(rmsOfPcm16(new Uint8Array(0))).toBe(0);
    expect(rmsOfPcm16(new Uint8Array(1))).toBe(0);
  });
});
