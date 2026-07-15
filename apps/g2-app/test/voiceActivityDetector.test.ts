import { describe, expect, it, vi } from 'vitest';
import type { VadConfig } from '../src/audio/voiceActivityDetector';
import { VoiceActivityDetector } from '../src/audio/voiceActivityDetector';

/**
 * Test config: 20 ms frames of 640 bytes (16 kHz s16le mono).
 *   pre-roll 100 ms = 5 frames · speech start = 3 frames · end silence 100 ms
 *   minimum speech 100 ms · maximum utterance 1000 ms
 */
const config: VadConfig = {
  sampleRateHz: 16_000,
  channels: 1,
  bitsPerSample: 16,
  frameMs: 20,
  preRollMs: 100,
  minimumSpeechMs: 100,
  endSilenceMs: 100,
  maximumUtteranceMs: 1_000,
  rmsThreshold: 0.05,
  speechStartFrameCount: 3,
};

const FRAME_BYTES = 640;
const FRAME_SAMPLES = FRAME_BYTES / 2;

function silenceFrame(): Uint8Array {
  return new Uint8Array(FRAME_BYTES);
}

/** Speech-like frame: 1 kHz sine at amplitude 8000 → RMS ≈ 0.17. */
function speechFrame(): Uint8Array {
  const frame = new Uint8Array(FRAME_BYTES);
  const view = new DataView(frame.buffer);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    const sample = Math.round(8000 * Math.sin((2 * Math.PI * 1000 * i) / 16_000));
    view.setInt16(i * 2, sample, true);
  }
  return frame;
}

/** One loud impulse in an otherwise silent frame — a click, not speech. */
function impulseFrame(): Uint8Array {
  const frame = new Uint8Array(FRAME_BYTES);
  const view = new DataView(frame.buffer);
  view.setInt16(0, 30_000, true);
  view.setInt16(2, -30_000, true);
  return frame;
}

function feed(vad: VoiceActivityDetector, frame: () => Uint8Array, count: number): void {
  for (let i = 0; i < count; i += 1) vad.push(frame());
}

function makeVad() {
  const onUtterance = vi.fn<(pcm: Uint8Array) => void>();
  const onSpeechStart = vi.fn();
  const onRejected = vi.fn();
  const vad = new VoiceActivityDetector(config, { onUtterance, onSpeechStart, onRejected });
  return { vad, onUtterance, onSpeechStart, onRejected };
}

describe('VoiceActivityDetector', () => {
  it('stays idle through pure silence', () => {
    const { vad, onUtterance, onSpeechStart } = makeVad();
    feed(vad, silenceFrame, 100);
    expect(onSpeechStart).not.toHaveBeenCalled();
    expect(onUtterance).not.toHaveBeenCalled();
    expect(vad.debugInfo.state).toBe('idle');
  });

  it('does not start recording from a single impulse', () => {
    const { vad, onUtterance, onSpeechStart } = makeVad();
    feed(vad, silenceFrame, 5);
    vad.push(impulseFrame());
    feed(vad, silenceFrame, 10);
    expect(onSpeechStart).not.toHaveBeenCalled();
    expect(onUtterance).not.toHaveBeenCalled();
  });

  it('starts recording after sustained speech frames', () => {
    const { vad, onSpeechStart } = makeVad();
    feed(vad, silenceFrame, 5);
    feed(vad, speechFrame, config.speechStartFrameCount);
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    expect(vad.debugInfo.state).toBe('recording');
    expect(vad.debugInfo.speaking).toBe(true);
  });

  it('emits the utterance with pre-roll after sustained silence', () => {
    const { vad, onUtterance } = makeVad();
    feed(vad, silenceFrame, 10); // pre-roll keeps only the last 5
    feed(vad, speechFrame, 20);
    feed(vad, silenceFrame, 5); // 100 ms of silence ends the utterance

    expect(onUtterance).toHaveBeenCalledTimes(1);
    const pcm = onUtterance.mock.calls[0]![0];
    // 5 pre-roll + 20 speech + 5 trailing silence frames.
    expect(pcm.length).toBe(30 * FRAME_BYTES);
  });

  it('rejects utterances with too little speech', () => {
    const { vad, onUtterance, onRejected } = makeVad();
    feed(vad, speechFrame, 3); // 60 ms of speech < 100 ms minimum
    feed(vad, silenceFrame, 5);
    expect(onUtterance).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith('too-short');
  });

  it('force-finishes at the maximum utterance duration', () => {
    const { vad, onUtterance } = makeVad();
    feed(vad, speechFrame, 60); // 1.2 s of continuous speech, never any silence
    expect(onUtterance).toHaveBeenCalledTimes(1);
    const pcm = onUtterance.mock.calls[0]![0];
    const durationMs = (pcm.length / FRAME_BYTES) * config.frameMs;
    expect(durationMs).toBeGreaterThanOrEqual(config.maximumUtteranceMs - config.frameMs);
    expect(durationMs).toBeLessThanOrEqual(config.maximumUtteranceMs + config.frameMs);
  });

  it('reset() drops all buffered audio and returns to idle', () => {
    const { vad, onUtterance } = makeVad();
    feed(vad, speechFrame, 10); // mid-recording
    vad.reset();
    feed(vad, silenceFrame, 10);
    expect(onUtterance).not.toHaveBeenCalled();
    expect(vad.debugInfo.state).toBe('idle');
    expect(vad.debugInfo.rms).toBe(0);
  });

  it('handles arbitrary chunk sizes (BLE fragmentation)', () => {
    const { vad, onUtterance } = makeVad();
    // Deliver the same audio as one big pre-concatenated chunk of odd size.
    const speech = new Uint8Array(20 * FRAME_BYTES);
    for (let i = 0; i < 20; i += 1) speech.set(speechFrame(), i * FRAME_BYTES);
    const silence = new Uint8Array(6 * FRAME_BYTES);
    for (let offset = 0; offset < speech.length; offset += 700) {
      vad.push(speech.subarray(offset, Math.min(offset + 700, speech.length)));
    }
    vad.push(silence);
    expect(onUtterance).toHaveBeenCalledTimes(1);
  });
});
