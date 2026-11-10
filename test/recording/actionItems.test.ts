import { ActionItemStore } from "../../src/main/recording/ActionItemStore";
import {
  ActionItemFinder,
  MAX_ITEMS,
  MIN_CHECK_GAP_MS,
  buildRequest,
  latestTurns,
  readItems,
} from "../../src/main/recording/actionItems";
import { RecordingStore } from "../../src/main/recording/RecordingStore";
import { Store } from "../../src/main/store/Store";
import type { Turn } from "../../src/shared/transcript";

const START = new Date(2026, 10, 9, 10).getTime();
const MIN = 60_000;

/** A reply that records these items through the answer tool. */
function reply(items: unknown): object {
  return { content: [{ type: "tool_use", name: "record_action_items", input: { items } }] };
}

describe("actionItems", () => {
  let store: Store;
  let recordings: RecordingStore;
  let items: ActionItemStore;
  let now: number;
  let invoke: ReturnType<typeof vi.fn<(body: object) => Promise<unknown>>>;
  let finder: ActionItemFinder;
  let id: number;

  beforeEach(() => {
    store = new Store(":memory:");
    recordings = new RecordingStore(store.db);
    items = new ActionItemStore(store.db);
    now = START + 10 * MIN;
    invoke = vi.fn<(body: object) => Promise<unknown>>(async () => reply([{ turn: 1, text: "  You:  send Dana the keys " }]));
    finder = new ActionItemFinder({ recordings, store: items, haiku: { invoke }, speakers: () => [], now: () => now });
    id = recordings.insertRecording(START, "/tmp/none");
  });

  afterEach(() => {
    store.close();
  });

  /** Adds a line to the call. */
  const say = (side: "me" | "them", at: number, text: string) => {
    recordings.insertLines(id, [{ side, start: at, end: at + 5_000, text }]);
  };

  it("should ask Haiku about a call with words, save the items and give them back", async () => {
    say("them", START, "Can you send me the sandbox keys?");
    say("me", START + MIN, "Sure, I'll send them today.");

    const report = await finder.refresh(id);

    expect(report).toEqual({ items: [{ text: "You: send Dana the keys", saidAt: START + MIN }], checkedAt: now, problem: null });
    expect(items.getItems(id)).toEqual({ recordingId: id, items: report.items, coveredUntil: START + MIN + 5_000, coveredLines: 2, checkedAt: now });
  });

  it("should not call Haiku for a call with no words, nothing new, or within a minute of the last look", async () => {
    expect(await finder.refresh(id)).toEqual({ items: [], checkedAt: null, problem: null });
    say("them", START, "Hello");
    say("me", START + MIN, "Hi");
    await finder.refresh(id);
    say("them", START + 2 * MIN, "One more thing");
    now += MIN_CHECK_GAP_MS - 1;
    await finder.refresh(id);
    expect(invoke).toHaveBeenCalledTimes(1);
    now += 1;
    await finder.refresh(id);
    expect(invoke).toHaveBeenCalledTimes(2);
    now += MIN_CHECK_GAP_MS * 2;
    await finder.refresh(id);

    expect(invoke).toHaveBeenCalledTimes(2);
    say("them", START + 3 * MIN, "Last thing");
    await finder.refresh(id);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("should count a line that arrives late, timed before the last one read, as new", async () => {
    say("them", START + 2 * MIN, "Their side, transcribed first");
    await finder.refresh(id);
    say("me", START + MIN, "My side, transcribed later: I'll send the keys");
    now += MIN_CHECK_GAP_MS;

    await finder.refresh(id);

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("should run one look at a time per call, sharing it with a second ask", async () => {
    say("them", START, "Hello");
    const [first, second] = await Promise.all([finder.refresh(id), finder.refresh(id)]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("should keep the saved items and report the problem when Haiku fails, then wait a minute to retry", async () => {
    say("them", START, "Hello");
    say("me", START + MIN, "Hi");
    await finder.refresh(id);
    say("them", START + 2 * MIN, "Bye");
    now += MIN_CHECK_GAP_MS;
    invoke.mockRejectedValueOnce(new Error("Bedrock said: throttled"));

    const failed = await finder.refresh(id);
    const soon = await finder.refresh(id);

    expect(failed.problem).toBe("Bedrock said: throttled");
    expect(failed.items).toEqual([{ text: "You: send Dana the keys", saidAt: START + MIN }]);
    expect(soon.problem).toBe("Bedrock said: throttled");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("should send the numbered turns and the items found earlier", async () => {
    say("them", START, "Can you send the keys?");
    say("me", START + MIN, "Yes.");
    await finder.refresh(id);
    say("them", START + 2 * MIN, "And the invoice.");
    now += MIN_CHECK_GAP_MS;

    await finder.refresh(id);

    const body = invoke.mock.calls[1][0] as { messages: { content: string }[]; tool_choice: unknown };
    expect(body.messages[0].content).toContain("[0] 10:00 AM Them: Can you send the keys?");
    expect(body.messages[0].content).toContain("[2] 10:02 AM Them: And the invoice.");
    expect(body.messages[0].content).toContain("- You: send Dana the keys (said at 10:01 AM)");
    expect(body.tool_choice).toEqual({ type: "tool", name: "record_action_items" });
  });

  it("should keep earlier items from before the part of a long call that was sent", async () => {
    items.saveItems({ recordingId: id, items: [{ text: "Old item", saidAt: START }], coveredUntil: START + 5_000, coveredLines: 1, checkedAt: START });
    say("them", START, "x".repeat(200_000));
    say("me", START + MIN, "Sure.");
    say("them", START + 2 * MIN, "Thanks.");
    invoke.mockResolvedValueOnce(reply([{ turn: 0, text: "You: do it" }]));

    const report = await finder.refresh(id);

    expect(report.items).toEqual([
      { text: "You: do it", saidAt: START + MIN },
      { text: "Old item", saidAt: START },
    ]);
  });

  it("should send the end of one turn too long to send whole, and keep the earlier items", async () => {
    items.saveItems({ recordingId: id, items: [{ text: "Old item", saidAt: START - MIN }], coveredUntil: START, coveredLines: 0, checkedAt: START });
    say("them", START, "x".repeat(150_000) + " please send the deck");
    invoke.mockResolvedValueOnce(reply([{ turn: 0, text: "You: send the deck" }]));

    const report = await finder.refresh(id);

    const body = invoke.mock.calls[0][0] as { messages: { content: string }[] };
    expect(body.messages[0].content).toContain("please send the deck");
    expect(report.items).toEqual([
      { text: "You: send the deck", saidAt: START },
      { text: "Old item", saidAt: START - MIN },
    ]);
  });

  it("should not show Haiku items from before the part it reads, nor keep a copy it restated", async () => {
    items.saveItems({
      recordingId: id,
      items: [
        { text: "Recent item", saidAt: START + MIN },
        { text: "Old item", saidAt: START },
      ],
      coveredUntil: START,
      coveredLines: 0,
      checkedAt: START,
    });
    say("them", START, "y".repeat(120_000));
    say("me", START + MIN, "Sure.");
    invoke.mockResolvedValueOnce(reply([{ turn: 0, text: "Old item" }]));

    const report = await finder.refresh(id);

    const body = invoke.mock.calls[0][0] as { messages: { content: string }[] };
    expect(body.messages[0].content).not.toContain("- Old item");
    expect(body.messages[0].content).toContain("- Recent item");
    expect(report.items.filter((item) => item.text === "Old item")).toHaveLength(1);
  });

  it("should take a final look at once when the call has ended, and never after it's long over", async () => {
    say("them", START, "Hello");
    await finder.refresh(id);
    recordings.finishRecording(id, now);
    say("me", START + 2 * MIN, "I'll send the notes");
    now += 5_000;
    await finder.refresh(id);
    expect(invoke).toHaveBeenCalledTimes(2);

    say("them", START + 3 * MIN, "One more");
    now += 11 * MIN;
    await finder.refresh(id);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("should refuse a call that isn't recorded", async () => {
    await expect(finder.refresh(999)).rejects.toThrow(/isn't recorded/);
  });
});

describe("readItems", () => {
  const turns: Turn[] = [
    { side: "them", speakerId: null, start: START, text: "a" },
    { side: "me", speakerId: null, start: START + MIN, text: "b" },
  ];

  it("should drop items with no text, a made-up turn or a repeat, and sort newest first", () => {
    const read = readItems(
      reply([
        { turn: 0, text: "First" },
        { turn: 1, text: "Second" },
        { turn: 7, text: "Nowhere" },
        { turn: 0.5, text: "Half" },
        { turn: 1, text: "   " },
        { turn: 1, text: "Second" },
        { text: "No turn" },
        "junk",
      ]),
      turns,
    );
    expect(read).toEqual([
      { text: "Second", saidAt: START + MIN },
      { text: "First", saidAt: START },
    ]);
  });

  it("should cut long items and keep at most the limit", () => {
    const many = Array.from({ length: MAX_ITEMS + 3 }, (_, i) => ({ turn: 0, text: `Item ${i} ${"y".repeat(300)}` }));
    const read = readItems(reply(many), turns);
    expect(read).toHaveLength(MAX_ITEMS);
    expect(read[0].text.length).toBe(200);
  });

  it("should refuse a reply with no list", () => {
    expect(() => readItems({ content: [{ type: "text", text: "Here you go" }] }, turns)).toThrow(/list of action items/);
    expect(() => readItems(null, turns)).toThrow(/list of action items/);
  });
});

describe("latestTurns", () => {
  it("should keep the latest turns that fit", () => {
    const turns: Turn[] = ["aaaa", "bb", "cc"].map((text, i) => ({ side: "me", speakerId: null, start: i, text }));
    expect(latestTurns(turns, 5).map((turn) => turn.text)).toEqual(["bb", "cc"]);
    expect(latestTurns(turns, 1)).toEqual([{ side: "me", speakerId: null, start: 2, text: "c" }]);
    expect(latestTurns([], 5)).toEqual([]);
  });
});

describe("buildRequest", () => {
  it("should say when no items were found yet", () => {
    const body = buildRequest([], []) as { messages: { content: string }[] };
    expect(body.messages[0].content).toContain("Action items found earlier:\nNone yet.");
  });
});
