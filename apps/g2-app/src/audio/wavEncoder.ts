/**
 * Browser-compatible PCM → WAV encoder. Input is raw s16le mono PCM as
 * captured from the G2 microphone; output is a valid RIFF/WAVE Blob suitable
 * for multipart upload. Uses only DataView/Blob — no Node Buffer APIs.
 */

export interface WavFormat {
  sampleRateHz: number;
  channels: number;
  bitsPerSample: number;
}

const HEADER_BYTES = 44;

/** Builds the canonical 44-byte RIFF header for the given PCM data length. */
export function buildWavHeader(pcmByteLength: number, format: WavFormat): ArrayBuffer {
  const { sampleRateHz, channels, bitsPerSample } = format;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRateHz * blockAlign;

  const header = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(header);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcmByteLength, true); // RIFF chunk size
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt subchunk size (PCM)
  view.setUint16(20, 1, true); // audio format 1 = linear PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcmByteLength, true); // data subchunk size

  return header;
}

/** Wraps raw PCM bytes into an audio/wav Blob. */
export function encodeWav(pcm: Uint8Array, format: WavFormat): Blob {
  const header = buildWavHeader(pcm.byteLength, format);
  // Copy the PCM into a plain ArrayBuffer-backed view so the Blob never
  // captures an oversized underlying buffer (or a SharedArrayBuffer).
  const body = pcm.slice() as Uint8Array<ArrayBuffer>;
  return new Blob([header, body], { type: 'audio/wav' });
}

/** Duration helper used for UI hints and pre-upload sanity checks. */
export function pcmDurationMs(pcmByteLength: number, format: WavFormat): number {
  const byteRate = format.sampleRateHz * format.channels * (format.bitsPerSample / 8);
  if (byteRate === 0) return 0;
  return (pcmByteLength / byteRate) * 1000;
}
