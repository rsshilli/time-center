import { parseWhisperJson } from "../../src/main/recording/whisper";

describe("parseWhisperJson", () => {
  it("should read the segments of whisper-cli's -oj output", () => {
    // The shape whisper.cpp 1.9.5 wrote for the 2026-11-06 probe, trimmed to the fields read.
    const text = JSON.stringify({
      systeminfo: "AVX = 0",
      transcription: [
        {
          timestamps: { from: "00:00:00,000", to: "00:00:06,420" },
          offsets: { from: 0, to: 6420 },
          text: " Hello, this is a test of the time center recorder.",
        },
        { offsets: { from: 6420 }, text: " missing its end" },
      ],
    });
    expect(parseWhisperJson(text)).toEqual([{ from: 0, to: 6420, text: " Hello, this is a test of the time center recorder." }]);
  });

  it("should give no segments when whisper heard nothing", () => {
    expect(parseWhisperJson("{}")).toEqual([]);
  });
});
