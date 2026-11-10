/** The sample rate every voiceprint is made at, and the rate the recorder and afconvert write. */
export const SAMPLE_RATE = 16_000;

/**
 * Reads a mono WAV file's samples: 16-bit PCM (the recorder's chunks) or 32-bit float, in a plain or an
 * "extensible" header (afconvert writes that one, which sherpa-onnx's own reader refuses).
 * @param bytes The file.
 * @returns The samples, -1 to 1, and the rate.
 */
export function readWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || text(bytes, 0) !== "RIFF" || text(bytes, 8) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }
  let format: { tag: number; channels: number; rate: number; bits: number } | null = null;
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = text(bytes, at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      const tag = view.getUint16(at + 8, true);
      // 0xFFFE (extensible) keeps the real format in the first two bytes of its sub-format GUID.
      format = {
        tag: tag === 0xfffe && size >= 40 ? view.getUint16(at + 32, true) : tag,
        channels: view.getUint16(at + 10, true),
        rate: view.getUint32(at + 12, true),
        bits: view.getUint16(at + 22, true),
      };
    } else if (id === "data") {
      if (!format) {
        throw new Error("The WAV file has no format.");
      }
      return { samples: decode(view, at + 8, Math.min(size, bytes.byteLength - at - 8), format), sampleRate: format.rate };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("The WAV file has no audio.");
}

/**
 * Turns the data chunk into samples.
 * @param view The file.
 * @param start Where the samples begin.
 * @param size Their length in bytes.
 * @param format The format.
 * @returns The samples, -1 to 1.
 */
function decode(view: DataView, start: number, size: number, format: { tag: number; channels: number; bits: number }): Float32Array {
  if (format.channels !== 1) {
    throw new Error("Only mono WAV files can be read.");
  }
  if (format.tag === 1 && format.bits === 16) {
    const samples = new Float32Array(Math.floor(size / 2));
    for (let i = 0; i < samples.length; i++) {
      samples[i] = view.getInt16(start + i * 2, true) / 32_768;
    }
    return samples;
  }
  if (format.tag === 3 && format.bits === 32) {
    const samples = new Float32Array(Math.floor(size / 4));
    for (let i = 0; i < samples.length; i++) {
      samples[i] = view.getFloat32(start + i * 4, true);
    }
    return samples;
  }
  throw new Error(`Unsupported WAV format ${format.tag}/${format.bits}-bit.`);
}

/**
 * The samples between two moments.
 * @param samples The whole file.
 * @param fromMs Start, in ms from the file's start.
 * @param toMs End.
 * @returns A copy (sherpa-onnx is given its own buffer).
 */
export function slice(samples: Float32Array, fromMs: number, toMs: number): Float32Array {
  const from = Math.max(0, Math.round((fromMs * SAMPLE_RATE) / 1000));
  const to = Math.min(samples.length, Math.round((toMs * SAMPLE_RATE) / 1000));
  return samples.slice(from, Math.max(from, to));
}

/**
 * Finds how far a call's mixed audio file is shifted from its transcript's times: the offset at which the
 * file is loudest inside the transcript's lines and quietest outside them. The recorder doesn't save when
 * the file starts, only roughly (the first sound either side heard).
 * @param samples The file.
 * @param lines The call's lines, in ms from the file's nominal start (the recording's start time).
 * @returns Milliseconds to subtract from a line's time to find it in the file (-3 s to 5 s, 100 ms steps).
 */
export function alignOffset(samples: Float32Array, lines: readonly { start: number; end: number }[]): number {
  const step = SAMPLE_RATE / 10;
  const loudness = new Float32Array(Math.floor(samples.length / step));
  for (let i = 0; i < loudness.length; i++) {
    let sum = 0;
    for (let j = i * step; j < (i + 1) * step; j += 4) {
      sum += Math.abs(samples[j]);
    }
    loudness[i] = sum;
  }
  let best = 0;
  let bestScore = -Infinity;
  for (let offset = -3_000; offset <= 5_000; offset += 100) {
    const inside = new Uint8Array(loudness.length);
    for (const line of lines) {
      for (let i = Math.max(0, Math.floor((line.start - offset) / 100)); i < Math.min(loudness.length, (line.end - offset) / 100); i++) {
        inside[i] = 1;
      }
    }
    let speech = 0;
    let speechCount = 0;
    let rest = 0;
    let restCount = 0;
    for (let i = 0; i < loudness.length; i++) {
      if (inside[i]) {
        speech += loudness[i];
        speechCount++;
      } else {
        rest += loudness[i];
        restCount++;
      }
    }
    const score = speech / Math.max(1, speechCount) - rest / Math.max(1, restCount);
    if (score > bestScore) {
      bestScore = score;
      best = offset;
    }
  }
  return best;
}

/**
 * Four ASCII letters of a file.
 * @param bytes The file.
 * @param at Where.
 * @returns The letters.
 */
function text(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + 4));
}
