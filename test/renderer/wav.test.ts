import { encodeWav } from "../../src/renderer/wav";

describe("encodeWav", () => {
  it("should write a mono 16-bit WAV header and the samples, clipped to the 16-bit range", () => {
    const buffer = encodeWav([new Float32Array([0, 1]), new Float32Array([-1, 2])], 16_000);
    const view = new DataView(buffer);
    const text = (offset: number) => String.fromCharCode(...new Uint8Array(buffer, offset, 4));

    expect(buffer.byteLength).toBe(44 + 4 * 2);
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });
});
