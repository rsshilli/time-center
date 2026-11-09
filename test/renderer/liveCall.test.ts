import { liveCall } from "../../src/renderer/LiveCallCard";
import type { CallRecording } from "../../src/shared/ipc";

const NINE = new Date(2026, 10, 9, 9).getTime();
const MIN = 60_000;

/** A call with defaults. */
const call = (fields: Partial<CallRecording>): CallRecording => ({
  id: 1,
  start: NINE,
  end: NINE + 30 * MIN,
  meetingTitle: null,
  mic: true,
  error: null,
  audioKept: true,
  waitingChunks: 0,
  unreadChunks: 0,
  lines: [],
  actionItems: [],
  actionItemsBehind: false,
  ...fields,
});

describe("liveCall", () => {
  it("should pick the call still recording", () => {
    const calls = [call({ id: 1 }), call({ id: 2, start: NINE + 60 * MIN, end: null })];
    expect(liveCall(calls, NINE + 70 * MIN)?.id).toBe(2);
  });

  it("should keep a call that just ended while its last words are transcribed, but not for long", () => {
    const calls = [call({ id: 3, waitingChunks: 2 })];
    expect(liveCall(calls, NINE + 35 * MIN)?.id).toBe(3);
    expect(liveCall(calls, NINE + 41 * MIN)).toBeNull();
  });

  it("should keep a call that just ended until Haiku has read its last words", () => {
    const calls = [call({ id: 4, actionItemsBehind: true })];
    expect(liveCall(calls, NINE + 31 * MIN)?.id).toBe(4);
    expect(liveCall(calls, NINE + 41 * MIN)).toBeNull();
  });

  it("should return null when every call is finished and transcribed", () => {
    expect(liveCall([call({})], NINE + 31 * MIN)).toBeNull();
    expect(liveCall([], NINE)).toBeNull();
  });
});
