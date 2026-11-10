import { SAMPLE_RATE, alignOffset, readWav, slice } from "../../src/main/speakers/wavSamples";

/**
 * A WAV file's bytes.
 * @param samples The samples, -1 to 1.
 * @param extensible Whether to write the "extensible" header afconvert writes.
 * @param float Whether to write 32-bit float rather than 16-bit PCM.
 * @returns The file.
 */
function wav(samples: number[], extensible = false, float = false): Uint8Array {
  const bytesPer = float ? 4 : 2;
  const fmtSize = extensible ? 40 : 16;
  const buffer = new ArrayBuffer(12 + 8 + fmtSize + 8 + 4 /* a chunk to skip */ + 8 + samples.length * bytesPer);
  const view = new DataView(buffer);
  const ascii = (at: number, value: string) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, extensible ? 0xfffe : float ? 3 : 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint16(34, bytesPer * 8, true);
  if (extensible) {
    view.setUint16(44, float ? 3 : 1, true);
  }
  let at = 20 + fmtSize;
  ascii(at, "LIST");
  view.setUint32(at + 4, 4, true);
  at += 12;
  ascii(at, "data");
  view.setUint32(at + 4, samples.length * bytesPer, true);
  samples.forEach((sample, index) => {
    if (float) {
      view.setFloat32(at + 8 + index * 4, sample, true);
    } else {
      view.setInt16(at + 8 + index * 2, Math.round(sample * 32_767), true);
    }
  });
  return new Uint8Array(buffer);
}

describe("readWav", () => {
  it("should read 16-bit PCM, as the recorder writes its chunks", () => {
    const { samples, sampleRate } = readWav(wav([0, 0.5, -0.5]));
    expect(sampleRate).toBe(SAMPLE_RATE);
    expect([...samples].map((value) => Math.round(value * 100) / 100)).toEqual([0, 0.5, -0.5]);
  });

  it("should read the extensible header afconvert writes, skipping other chunks", () => {
    expect([...readWav(wav([0.25], true)).samples].map((value) => Math.round(value * 100) / 100)).toEqual([0.25]);
    expect([...readWav(wav([0.25], true, true)).samples]).toEqual([0.25]);
  });

  it("should refuse something that isn't a WAV file", () => {
    expect(() => readWav(new TextEncoder().encode("not a wav file"))).toThrow("Not a WAV file.");
  });
});

describe("slice", () => {
  it("should copy the samples between two moments, clamped to the file", () => {
    const samples = Float32Array.from({ length: SAMPLE_RATE }, (_, index) => index);
    const piece = slice(samples, 500, 2_000);
    expect(piece.length).toBe(SAMPLE_RATE / 2);
    expect(piece[0]).toBe(SAMPLE_RATE / 2);
    piece[0] = -1;
    expect(samples[SAMPLE_RATE / 2]).toBe(SAMPLE_RATE / 2);
    expect(slice(samples, -100, 0).length).toBe(0);
  });
});

describe("alignOffset", () => {
  it("should find how far the file is shifted from the transcript's times", () => {
    const samples = new Float32Array(SAMPLE_RATE * 20).fill(0.01);
    // Speech in the file at 2.0–4.0 s and 9.0–12.0 s; the transcript says 1.4–3.4 s and 8.4–11.4 s.
    for (const [from, to] of [
      [2, 4],
      [9, 12],
    ]) {
      samples.fill(0.5, from * SAMPLE_RATE, to * SAMPLE_RATE);
    }
    expect(alignOffset(samples, [{ start: 1_400, end: 3_400 }, { start: 8_400, end: 11_400 }])).toBe(-600);
  });
});
