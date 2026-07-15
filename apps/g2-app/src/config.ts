/**
 * Every tunable frontend value lives here. Other modules must not contain
 * magic numbers — if a constant needs adjusting during calibration on real
 * glasses, this is the only file to touch.
 */

export const appConfig = {
  api: {
    /**
     * Worker base URL, injected at build time via VITE_TRANSLATION_API_URL
     * (see .env.example). This is a public URL, never a credential.
     */
    baseUrl: (import.meta.env.VITE_TRANSLATION_API_URL ?? 'http://localhost:8787').replace(
      /\/+$/,
      '',
    ),
    /** Whole-request budget: upload + transcription + translation. */
    requestTimeoutMs: 30_000,
  },

  display: {
    widthPx: 576,
    heightPx: 288,
    /**
     * Three stacked text containers. IDs and names are stable: the initial
     * page is built once with createStartUpPageContainer, every later change
     * goes through textContainerUpgrade targeting these IDs.
     */
    containers: {
      header: { id: 1, name: 'tt-header', x: 0, y: 0, width: 576, height: 34, zOrder: 1 },
      body: { id: 2, name: 'tt-body', x: 0, y: 38, width: 576, height: 204, zOrder: 2 },
      footer: { id: 3, name: 'tt-footer', x: 0, y: 246, width: 576, height: 42, zOrder: 3 },
    },
    /** Inner padding applied by the OS renderer; subtracted before measuring. */
    containerPaddingPx: 4,
    /** Coalesce rapid display writes — the BLE render queue is slow. */
    renderDebounceMs: 120,
    /** Hard cap for any single container payload, well under SDK limits. */
    maxDisplayedChars: 360,
  },

  audio: {
    sampleRateHz: 16_000,
    channels: 1,
    bitsPerSample: 16,
  },

  /**
   * Voice-activity detection. `rmsThreshold` is normalized to 0..1
   * (full-scale s16 = 1.0). Calibrate on real hardware via the phone
   * diagnostics panel, which shows the live RMS value.
   */
  vad: {
    sampleRateHz: 16_000,
    channels: 1,
    bitsPerSample: 16,
    /** Analysis frame length; incoming BLE chunks are re-framed to this. */
    frameMs: 20,
    /** Audio kept from before speech onset so first syllables survive. */
    preRollMs: 250,
    /** Utterances shorter than this are rejected as noise. */
    minimumSpeechMs: 300,
    /**
     * Sustained silence that ends an utterance. Generous on purpose: people
     * breathe and pause to think mid-sentence, and a natural pause must not
     * split one thought into two premature translations.
     */
    endSilenceMs: 1_800,
    /** Hard stop: force-finish the utterance at this length. */
    maximumUtteranceMs: 30_000,
    /** Normalized RMS a frame must exceed to count as speech. */
    rmsThreshold: 0.015,
    /** Consecutive speech frames required to enter recording (rejects clicks). */
    speechStartFrameCount: 3,
  },

  conversation: {
    /** Ignore direction-toggle clicks arriving faster than this. */
    toggleDebounceMs: 400,
    /**
     * Minimum interval between UI updates that carry only a new VAD RMS
     * reading. VAD frames arrive every 20 ms; re-rendering both surfaces at
     * that rate is wasted work, so RMS-only updates are throttled while
     * state changes still propagate immediately.
     */
    vadDebugThrottleMs: 250,
  },

  bridge: {
    /** How long to wait for the Even App bridge before assuming a plain browser. */
    connectTimeoutMs: 4_000,
  },
} as const;

export type AppConfig = typeof appConfig;
