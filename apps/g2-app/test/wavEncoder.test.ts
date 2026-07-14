import { describe, expect, it } from 'vitest';
import { buildWavHeader, encodeWav, pcmDurationMs } from '../src/audio/wavEncoder';

const FORMAT = { sampleRateHz: 16_000, channels: 1, bitsPerSample: 16 };

function ascii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

describe('buildWavHeader', () => {
  it('writes a correct RIFF header for 16 kHz mono s16le', () => {
    const dataLength = 32_000; // one second
    const view = new DataView(buildWavHeader(dataLength, FORMAT));

    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + dataLength);
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16); // PCM fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // linear PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000); // sample rate
    expect(view.getUint32(28, true)).toBe(32_000); // byte rate = rate * block align
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(dataLength);
  });
});

describe('encodeWav', () => {
  it('produces an audio/wav blob of header + data size', async () => {
    const pcm = new Uint8Array(1234);
    const blob = encodeWav(pcm, FORMAT);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 1234);

    const bytes = new DataView(await blob.arrayBuffer());
    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(bytes.getUint32(40, true)).toBe(1234);
  });

  it('round-trips the PCM payload byte for byte', async () => {
    const pcm = new Uint8Array(512);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = i % 256;
    const blob = encodeWav(pcm, FORMAT);
    const all = new Uint8Array(await blob.arrayBuffer());
    expect([...all.subarray(44)]).toEqual([...pcm]);
  });
});

describe('pcmDurationMs', () => {
  it('computes duration from byte length', () => {
    expect(pcmDurationMs(32_000, FORMAT)).toBe(1000);
    expect(pcmDurationMs(16_000, FORMAT)).toBe(500);
    expect(pcmDurationMs(0, FORMAT)).toBe(0);
  });
});
