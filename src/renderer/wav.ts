/** The rate whisper wants, and the rate the microphone is captured at for dictation. */
export const DICTATION_SAMPLE_RATE = 16_000;

/**
 * Packs captured audio into a mono 16-bit PCM WAV file, the format whisper-cli reads.
 * @param chunks The samples, -1 to 1, in the order captured.
 * @param sampleRate Samples per second.
 * @returns The file's bytes.
 */
export function encodeWav(chunks: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  writeText(view, 0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  writeText(view, 8, "WAVE");
  writeText(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(view, 36, "data");
  view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clipped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

/**
 * Writes ASCII text into the header.
 * @param view The file.
 * @param offset Where.
 * @param text The text.
 */
function writeText(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
