import { chunkFromFileName, parseRecorderLine } from "../../src/main/recording/recorderProcess";

describe("parseRecorderLine", () => {
  it("should read the lines the Swift recorder really prints", () => {
    // Copied from the recorder's output in the 2026-11-06 probe.
    expect(parseRecorderLine('{"mic":true,"ready":true}')).toEqual({ kind: "ready", mic: true });
    expect(
      parseRecorderLine('{"t0":1794008494074,"src":"them","wav":"\\/tmp\\/rec\\/chunks\\/them-1794008494074-1.wav"}'),
    ).toEqual({ kind: "chunk", chunk: { wav: "/tmp/rec/chunks/them-1794008494074-1.wav", side: "them", t0: 1794008494074 } });
    expect(parseRecorderLine('{"error":"No display found"}')).toEqual({ kind: "error", message: "No display found" });
  });

  it("should drop warnings, odd sides and lines that aren't JSON", () => {
    expect(parseRecorderLine('{"warning":"Could not create me.m4a"}')).toBeNull();
    expect(parseRecorderLine('{"t0":1,"src":"both","wav":"/x.wav"}')).toBeNull();
    expect(parseRecorderLine("not json")).toBeNull();
  });
});

describe("chunkFromFileName", () => {
  it("should read the side and start back from a leftover chunk's name, and ignore other files", () => {
    expect(chunkFromFileName("/r/chunks/me-1794008490283-1.wav")).toEqual({
      wav: "/r/chunks/me-1794008490283-1.wav",
      side: "me",
      t0: 1794008490283,
    });
    expect(chunkFromFileName("/r/chunks/me-1794008490283-1.wav.failed")).toBeNull();
    expect(chunkFromFileName("/r/chunks/me-1794008490283-1.wav.part")).toBeNull();
  });
});
