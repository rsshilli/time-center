import { ActionItemStore } from "../../src/main/recording/ActionItemStore";
import {
  ActionItemFinder,
  MAX_ITEMS,
  buildRequest,
  keepEarlier,
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
    finder = new ActionItemFinder({ recordings, store: items, model: { invoke }, speakers: () => [], now: () => now });
    id = recordings.insertRecording(START, "/tmp/none");
  });

  afterEach(() => {
    store.close();
  });

  /** Adds a line to the call. */
  const say = (side: "me" | "them", at: number, text: string) => {
    recordings.insertLines(id, [{ side, start: at, end: at + 5_000, text }]);
  };

  it("should scan a call with words, save the items and give them back", async () => {
    say("them", START, "Can you send me the sandbox keys?");
    say("me", START + MIN, "Sure, I'll send them today.");

    const report = await finder.scan(id);

    expect(report).toEqual({ items: [{ text: "You: send Dana the keys", saidAt: START + MIN }], checkedAt: now });
    expect(items.getItems(id)).toEqual({ recordingId: id, items: report.items, coveredUntil: START + MIN + 5_000, coveredLines: 2, checkedAt: now });
  });

  it("should refuse to scan a call with no words, without asking the model", async () => {
    await expect(finder.scan(id)).rejects.toThrow(/Nothing has been said/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("should ask the model every time you scan, even straight after the last scan", async () => {
    say("them", START, "Hello");
    await finder.scan(id);
    await finder.scan(id);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("should scan a call that ended long ago", async () => {
    say("them", START, "Hello");
    recordings.finishRecording(id, START + MIN);
    now += 24 * 60 * MIN;
    await finder.scan(id);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("should run one scan at a time per call, sharing it with a second press", async () => {
    say("them", START, "Hello");
    const [first, second] = await Promise.all([finder.scan(id), finder.scan(id)]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("should keep the saved items and pass on the problem when the model fails", async () => {
    say("them", START, "Hello");
    say("me", START + MIN, "Hi");
    await finder.scan(id);
    invoke.mockRejectedValueOnce(new Error("Bedrock said: throttled"));

    await expect(finder.scan(id)).rejects.toThrow("Bedrock said: throttled");

    expect(items.getItems(id)?.items).toEqual([{ text: "You: send Dana the keys", saidAt: START + MIN }]);
  });

  it("should send the numbered turns and the items found earlier", async () => {
    say("them", START, "Can you send the keys?");
    say("me", START + MIN, "Yes.");
    await finder.scan(id);
    say("them", START + 2 * MIN, "And the invoice.");

    await finder.scan(id);

    const body = invoke.mock.calls[1][0] as { messages: { content: string }[]; tool_choice: unknown };
    expect(body.messages[0].content).toContain("[0] 10:00 AM Them: Can you send the keys?");
    expect(body.messages[0].content).toContain("[2] 10:02 AM Them: And the invoice.");
    expect(body.messages[0].content).toContain("- You: send Dana the keys (said at 10:01 AM)");
    expect(body.tool_choice).toEqual({ type: "auto" });
  });

  it("should keep earlier items from before the part of a long call that was sent", async () => {
    items.saveItems({ recordingId: id, items: [{ text: "Old item", saidAt: START }], coveredUntil: START + 5_000, coveredLines: 1, checkedAt: START });
    say("them", START, "x".repeat(200_000));
    say("me", START + MIN, "Sure.");
    say("them", START + 2 * MIN, "Thanks.");
    invoke.mockResolvedValueOnce(reply([{ turn: 0, text: "You: do it" }]));

    const report = await finder.scan(id);

    expect(report.items).toEqual([
      { text: "You: do it", saidAt: START + MIN },
      { text: "Old item", saidAt: START },
    ]);
  });

  it("should send the end of one turn too long to send whole, and keep the earlier items", async () => {
    items.saveItems({ recordingId: id, items: [{ text: "Old item", saidAt: START - MIN }], coveredUntil: START, coveredLines: 0, checkedAt: START });
    say("them", START, "x".repeat(150_000) + " please send the deck");
    invoke.mockResolvedValueOnce(reply([{ turn: 0, text: "You: send the deck" }]));

    const report = await finder.scan(id);

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

    const report = await finder.scan(id);

    const body = invoke.mock.calls[0][0] as { messages: { content: string }[] };
    expect(body.messages[0].content).not.toContain("- Old item");
    expect(body.messages[0].content).toContain("- Recent item");
    expect(report.items.filter((item) => item.text === "Old item")).toHaveLength(1);
  });

  it("should keep every earlier item when Haiku answers mid-call with an empty list", async () => {
    say("them", START, "Can you send the keys?");
    say("me", START + MIN, "Yes.");
    await finder.scan(id);
    say("them", START + 2 * MIN, "Great, talk soon.");
    invoke.mockResolvedValueOnce(reply([]));

    const report = await finder.scan(id);

    expect(report.items).toEqual([{ text: "You: send Dana the keys", saidAt: START + MIN }]);
    expect(items.getItems(id)?.items).toEqual(report.items);
  });

  it("should refuse a call that isn't recorded", async () => {
    await expect(finder.scan(999)).rejects.toThrow(/isn't recorded/);
  });
});

describe("readItems", () => {
  const turns: Turn[] = [
    { side: "them", speakerId: null, start: START, text: "a", lines: [] },
    { side: "me", speakerId: null, start: START + MIN, text: "b", lines: [] },
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

describe("keepEarlier", () => {
  const a = { text: "You: send the keys", saidAt: 2 };
  const b = { text: "Them: check the invoice", saidAt: 1 };

  it("should keep earlier items the answer left out, newest first", () => {
    expect(keepEarlier([], [a, b])).toEqual([a, b]);
    expect(keepEarlier([b], [a])).toEqual([a, b]);
  });

  it("should let a reworded item said at the same moment replace the old wording", () => {
    const reworded = { text: "You: send Dana the sandbox keys", saidAt: 2 };
    expect(keepEarlier([reworded], [a, b])).toEqual([reworded, b]);
  });

  it("should not keep two copies of the same words", () => {
    expect(keepEarlier([a], [a, b])).toEqual([a, b]);
  });
});

describe("latestTurns", () => {
  it("should keep the latest turns that fit", () => {
    const turns: Turn[] = ["aaaa", "bb", "cc"].map((text, i) => ({ side: "me", speakerId: null, start: i, text, lines: [] }));
    expect(latestTurns(turns, 5).map((turn) => turn.text)).toEqual(["bb", "cc"]);
    expect(latestTurns(turns, 1)).toEqual([{ side: "me", speakerId: null, start: 2, text: "c", lines: [] }]);
    expect(latestTurns([], 5)).toEqual([]);
  });
});

describe("buildRequest", () => {
  it("should say when no items were found yet", () => {
    const body = buildRequest([], []) as { messages: { content: string }[] };
    expect(body.messages[0].content).toContain("Action items found earlier:\nNone yet.");
  });
});
