import { assertCatchUpMinutes, catchUp, readSummary } from "../../src/main/recording/catchUp";
import { RecordingStore } from "../../src/main/recording/RecordingStore";
import { Store } from "../../src/main/store/Store";

const START = new Date(2026, 10, 17, 10).getTime();
const MIN = 60_000;

describe("catchUp", () => {
  let store: Store;
  let recordings: RecordingStore;
  let id: number;
  let invoke: ReturnType<typeof vi.fn<(body: object) => Promise<unknown>>>;

  beforeEach(() => {
    store = new Store(":memory:");
    recordings = new RecordingStore(store.db);
    id = recordings.insertRecording(START, "/tmp/none");
    invoke = vi.fn<(body: object) => Promise<unknown>>(async () => ({ content: [{ type: "text", text: "- Dana asked you for the keys.\n" }] }));
  });

  afterEach(() => {
    store.close();
  });

  /** Catches up on the call at a moment. */
  const run = (minutes: 2 | 5 | 10, now: number) => catchUp({ recordings, haiku: { invoke }, speakers: () => [], now: () => now }, id, minutes);

  it("should send Haiku only what was said in the last few minutes and give back its summary", async () => {
    recordings.insertLines(id, [
      { side: "them", start: START, end: START + 5_000, text: "Long ago: the budget is fine." },
      { side: "them", start: START + 8 * MIN, end: START + 8 * MIN + 5_000, text: "Ryan, can you send me the keys?" },
    ]);

    const result = await run(5, START + 10 * MIN);

    const sent = JSON.stringify(invoke.mock.calls[0][0]);
    expect(sent).toContain("can you send me the keys");
    expect(sent).not.toContain("the budget is fine");
    expect(sent).toContain("The last 5 minutes");
    expect(result).toEqual({ minutes: 5, from: START + 5 * MIN, to: START + 10 * MIN, summary: "- Dana asked you for the keys.", turns: 1 });
  });

  it("should say nothing was said, without asking Haiku, when the call was quiet", async () => {
    recordings.insertLines(id, [{ side: "me", start: START, end: START + 5_000, text: "Hello." }]);

    const result = await run(2, START + 10 * MIN);

    expect(invoke).not.toHaveBeenCalled();
    expect(result.summary).toBe("Nothing was said in the last 2 minutes.");
    expect(result.turns).toBe(0);
  });

  it("should count back from the end of a call that has ended", async () => {
    recordings.insertLines(id, [{ side: "them", start: START + 9 * MIN, end: START + 9 * MIN + 5_000, text: "Wrapping up." }]);
    recordings.finishRecording(id, START + 10 * MIN);

    const result = await run(2, START + 60 * MIN);

    expect(result.to).toBe(START + 10 * MIN);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("should refuse a call that isn't recorded", async () => {
    await expect(catchUp({ recordings, haiku: { invoke }, speakers: () => [], now: () => START }, 999, 2)).rejects.toThrow("isn't recorded");
  });

  describe("readSummary", () => {
    it("should join the reply's text and refuse an empty one", () => {
      expect(readSummary({ content: [{ type: "text", text: " - a " }, { type: "tool_use" }, { type: "text", text: "- b" }] })).toBe("- a \n- b");
      expect(() => readSummary({ content: [] })).toThrow("didn't send back a summary");
      expect(() => readSummary(null)).toThrow();
    });
  });

  describe("assertCatchUpMinutes", () => {
    it("should accept only 2, 5 or 10", () => {
      expect(assertCatchUpMinutes(5)).toBe(5);
      for (const bad of [3, "5", null, 60]) {
        expect(() => assertCatchUpMinutes(bad)).toThrow();
      }
    });
  });
});
