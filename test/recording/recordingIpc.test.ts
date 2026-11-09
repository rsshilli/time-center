import {
  MAX_DICTATION_BYTES,
  MAX_QUESTION_CHARS,
  assertDictation,
  assertQuestionRequest,
} from "../../src/main/recording/recordingIpc";

const AT = new Date(2026, 10, 9, 12).getTime();

/** A WAV-shaped buffer of a given size. */
function wav(bytes: number): ArrayBuffer {
  const buffer = new Uint8Array(bytes);
  buffer.set(new TextEncoder().encode("RIFF"));
  return buffer.buffer;
}

describe("recordingIpc", () => {
  it("should accept a question for each scope, with a call only for this call", () => {
    expect(assertQuestionRequest({ question: "Hi?", scope: "call", at: AT, recordingId: 3 })).toEqual({
      question: "Hi?",
      scope: "call",
      at: AT,
      recordingId: 3,
    });
    expect(assertQuestionRequest({ question: "Hi?", scope: "all", at: AT })).toEqual({ question: "Hi?", scope: "all", at: AT, recordingId: null });
  });

  it("should refuse a question with a bad scope, no call for this call, a bad day or too many characters", () => {
    expect(() => assertQuestionRequest(null)).toThrow(/Not a question/);
    expect(() => assertQuestionRequest({ question: "Hi?", scope: "week", at: AT })).toThrow(/this call, this day or all calls/);
    expect(() => assertQuestionRequest({ question: "Hi?", scope: "call", at: AT, recordingId: null })).toThrow(/Choose a call/);
    expect(() => assertQuestionRequest({ question: "Hi?", scope: "day", at: "noon" })).toThrow(/Not a moment/);
    expect(() => assertQuestionRequest({ question: "x".repeat(MAX_QUESTION_CHARS + 1), scope: "day", at: AT })).toThrow(/up to/);
  });

  it("should accept dictated WAV audio and refuse anything else or anything too long", () => {
    expect(assertDictation(wav(100)).byteLength).toBe(100);
    expect(() => assertDictation(new ArrayBuffer(100))).toThrow(/WAV/);
    expect(() => assertDictation("RIFF")).toThrow(/WAV/);
    expect(() => assertDictation(wav(MAX_DICTATION_BYTES + 1))).toThrow(/two minutes/);
  });
});
