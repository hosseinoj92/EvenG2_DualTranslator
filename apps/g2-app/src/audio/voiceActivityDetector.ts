/**
 * Lightweight RMS-energy voice-activity detector. No external WASM models —
 * a G2 conversation happens close to the microphone, where simple energy
 * gating with a pre-roll buffer is reliable and fully calibratable via one
 * config object (see appConfig.vad).
 *
 * Lifecycle per utterance:
 *   idle → (speechStartFrameCount consecutive loud frames) → recording
 *        → (endSilenceMs of quiet) → onUtterance(pcm) → idle
 * A lone loud click never starts recording; a recording capped at
 * maximumUtteranceMs is force-finished; anything shorter than
 * minimumSpeechMs is rejected.
 */

import { FrameSlicer, PreRollBuffer, concatPcm, rmsOfPcm16 } from './pcmBuffer';
import type { VadDebugInfo } from '../types';

export interface VadConfig {
  sampleRateHz: number;
  channels: number;
  bitsPerSample: number;
  frameMs: number;
  preRollMs: number;
  minimumSpeechMs: number;
  endSilenceMs: number;
  maximumUtteranceMs: number;
  rmsThreshold: number;
  speechStartFrameCount: number;
}

export interface VadCallbacks {
  /** Fired once when an utterance transitions from maybe-speech to recording. */
  onSpeechStart?: () => void;
  /** Fired with the complete utterance PCM (pre-roll included). */
  onUtterance: (pcm: Uint8Array) => void;
  /** Fired when a candidate utterance is discarded. */
  onRejected?: (reason: 'too-short') => void;
  /** Fired on every processed frame with live diagnostics. */
  onDebug?: (info: VadDebugInfo) => void;
}

type VadState = 'idle' | 'maybe-speech' | 'recording';

export class VoiceActivityDetector {
  private readonly slicer: FrameSlicer;
  private readonly preRoll: PreRollBuffer;
  private readonly frameBytes: number;

  private state: VadState = 'idle';
  private candidateFrames: Uint8Array[] = [];
  private utteranceFrames: Uint8Array[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  private recordedMs = 0;
  private lastRms = 0;

  constructor(
    private readonly config: VadConfig,
    private readonly callbacks: VadCallbacks,
  ) {
    const bytesPerMs = (config.sampleRateHz * (config.bitsPerSample / 8) * config.channels) / 1000;
    this.frameBytes = Math.max(2, Math.round(bytesPerMs * config.frameMs));
    this.slicer = new FrameSlicer(this.frameBytes);
    this.preRoll = new PreRollBuffer(Math.round(bytesPerMs * config.preRollMs));
  }

  /** Feed raw PCM from the microphone. Chunk sizes are arbitrary. */
  push(chunk: Uint8Array): void {
    for (const frame of this.slicer.push(chunk)) {
      this.processFrame(frame);
    }
  }

  /** Drops all buffered audio and returns to idle. Called on direction change. */
  reset(): void {
    this.slicer.reset();
    this.preRoll.clear();
    this.candidateFrames = [];
    this.utteranceFrames = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.recordedMs = 0;
    this.state = 'idle';
    this.lastRms = 0;
    this.emitDebug();
  }

  get debugInfo(): VadDebugInfo {
    return { rms: this.lastRms, speaking: this.state === 'recording', state: this.state };
  }

  /**
   * Non-destructive copy of the utterance recorded so far (pre-roll
   * included). Null unless currently recording. Used for live preview
   * transcription of long sentences; recording continues unaffected.
   */
  snapshotUtterance(): Uint8Array | null {
    if (this.state !== 'recording' || this.utteranceFrames.length === 0) {
      return null;
    }
    return concatPcm(this.utteranceFrames);
  }

  private processFrame(frame: Uint8Array): void {
    const rms = rmsOfPcm16(frame);
    this.lastRms = rms;
    const isSpeech = rms >= this.config.rmsThreshold;

    switch (this.state) {
      case 'idle':
        this.preRoll.push(frame);
        if (isSpeech) {
          this.state = 'maybe-speech';
          this.candidateFrames = [frame];
        }
        break;

      case 'maybe-speech':
        if (isSpeech) {
          this.candidateFrames.push(frame);
          if (this.candidateFrames.length >= this.config.speechStartFrameCount) {
            this.beginRecording();
          }
        } else {
          // Isolated impulse (a click, a cough fragment) — not speech.
          for (const candidate of this.candidateFrames) this.preRoll.push(candidate);
          this.preRoll.push(frame);
          this.candidateFrames = [];
          this.state = 'idle';
        }
        break;

      case 'recording':
        this.utteranceFrames.push(frame);
        this.recordedMs += this.config.frameMs;
        if (isSpeech) {
          this.speechMs += this.config.frameMs;
          this.silenceMs = 0;
        } else {
          this.silenceMs += this.config.frameMs;
        }
        if (this.silenceMs >= this.config.endSilenceMs) {
          this.finishUtterance();
        } else if (this.recordedMs >= this.config.maximumUtteranceMs) {
          this.finishUtterance();
        }
        break;
    }

    this.emitDebug();
  }

  private beginRecording(): void {
    const preRollAudio = this.preRoll.drain();
    this.utteranceFrames = preRollAudio.length > 0 ? [preRollAudio] : [];
    this.utteranceFrames.push(...this.candidateFrames);
    this.recordedMs =
      (preRollAudio.length / this.frameBytes + this.candidateFrames.length) * this.config.frameMs;
    this.speechMs = this.candidateFrames.length * this.config.frameMs;
    this.silenceMs = 0;
    this.candidateFrames = [];
    this.state = 'recording';
    this.callbacks.onSpeechStart?.();
  }

  private finishUtterance(): void {
    const pcm = concatPcm(this.utteranceFrames);
    const hadEnoughSpeech = this.speechMs >= this.config.minimumSpeechMs;
    this.utteranceFrames = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.recordedMs = 0;
    this.state = 'idle';

    if (!hadEnoughSpeech || pcm.length === 0) {
      this.callbacks.onRejected?.('too-short');
      return;
    }
    this.callbacks.onUtterance(pcm);
  }

  private emitDebug(): void {
    this.callbacks.onDebug?.(this.debugInfo);
  }
}
