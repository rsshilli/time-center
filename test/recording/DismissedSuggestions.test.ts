import { ActionItemStore } from "../../src/main/recording/ActionItemStore";
import { ActionItemFinder } from "../../src/main/recording/actionItems";
import { CallQuestionStore } from "../../src/main/recording/CallQuestionStore";
import { DismissedSuggestions, MAX_SUGGESTION_CHARS, assertSuggestionRef } from "../../src/main/recording/DismissedSuggestions";
import { RecordingStore } from "../../src/main/recording/RecordingStore";
import { Store } from "../../src/main/store/Store";

const START = new Date(2026, 10, 17, 10).getTime();
const MIN = 60_000;

describe("DismissedSuggestions", () => {
  let store: Store;
  let recordings: RecordingStore;
  let dismissed: DismissedSuggestions;
  let id: number;

  beforeEach(() => {
    store = new Store(":memory:");
    recordings = new RecordingStore(store.db);
    dismissed = new DismissedSuggestions(store.db);
    id = recordings.insertRecording(START, "/tmp/none");
  });

  afterEach(() => {
    store.close();
  });

  describe("dismiss and restore", () => {
    it("should hide only the suggestion with that call, moment and words, and bring it back on restore", () => {
      const keys = { recordingId: id, saidAt: START + MIN, text: "You: send Dana the keys" };
      const sameWordsOtherMoment = { ...keys, saidAt: START + 2 * MIN };
      const otherWords = { ...keys, text: "Them: check the invoice" };

      dismissed.dismiss(keys, START);
      dismissed.dismiss(keys, START + 1);

      expect(dismissed.without([keys, sameWordsOtherMoment, otherWords])).toEqual([sameWordsOtherMoment, otherWords]);
      expect(dismissed.list(id)).toEqual([keys]);
      dismissed.restore(keys);
      expect(dismissed.without([keys])).toEqual([keys]);
    });

    it("should forget a call's dismissals when the call is deleted", () => {
      dismissed.dismiss({ recordingId: id, saidAt: START, text: "x" }, START);
      store.db.prepare("DELETE FROM recordings WHERE id = ?").run(id);

      expect(store.db.prepare("SELECT COUNT(*) AS n FROM recording_dismissed_suggestions").get()).toEqual({ n: 0 });
    });
  });

  describe("the stores that read suggestions", () => {
    it("should leave a dismissed action item out of the call's items", () => {
      const items = new ActionItemStore(store.db);
      const keep = { text: "Them: check the invoice", saidAt: START };
      const drop = { text: "You: send Dana the keys", saidAt: START + MIN };
      items.saveItems({ recordingId: id, items: [drop, keep], coveredUntil: START + 2 * MIN, coveredLines: 2, checkedAt: START });

      dismissed.dismiss({ recordingId: id, ...drop }, START);

      expect(items.getItems(id)?.items).toEqual([keep]);
      expect(items.listDismissed(id)).toEqual([drop]);
    });

    it("should leave a dismissed TODO out of a question's found TODOs", () => {
      const questions = new CallQuestionStore(store.db);
      const keep = { text: "Book the room", recordingId: id, saidAt: START };
      const drop = { text: "Send the deck", recordingId: id, saidAt: START + MIN };
      questions.insertQuestion({ askedAt: START, question: "What do I owe?", scope: "call", sources: [], note: null, answer: "Two things.", error: null, todos: [keep, drop] });

      dismissed.dismiss(drop, START);

      expect(questions.listQuestions(5)[0].todos).toEqual([keep]);
    });
  });

  describe("Haiku looking again", () => {
    it("should tell Haiku what was dismissed and drop it if Haiku suggests it anyway", async () => {
      const items = new ActionItemStore(store.db);
      recordings.insertLines(id, [{ side: "me", start: START, end: START + 5_000, text: "I'll send Dana the keys and book the room." }]);
      dismissed.dismiss({ recordingId: id, saidAt: START, text: "You: send Dana the keys" }, START);
      const invoke = vi.fn(async (_body: object) => ({
        content: [
          {
            type: "tool_use",
            name: "record_action_items",
            input: { items: [{ turn: 0, text: "You: send Dana the keys" }, { turn: 0, text: "You: book the room" }] },
          },
        ],
      }));
      const finder = new ActionItemFinder({ recordings, store: items, haiku: { invoke }, speakers: () => [], now: () => START + 10 * MIN });

      const report = await finder.refresh(id);

      expect(JSON.stringify(invoke.mock.calls[0][0])).toContain("dismissed these as not action items");
      expect(report.items.map((item) => item.text)).toEqual(["You: book the room"]);
      expect(items.getItems(id)?.items.map((item) => item.text)).toEqual(["You: book the room"]);
    });
  });

  describe("Undo after Haiku looked again", () => {
    it("should keep a dismissed item saved through Haiku's next look, so Undo brings it back", async () => {
      const items = new ActionItemStore(store.db);
      const drop = { text: "You: send Dana the keys", saidAt: START };
      items.saveItems({ recordingId: id, items: [drop], coveredUntil: START + 5_000, coveredLines: 1, checkedAt: START });
      recordings.insertLines(id, [
        { side: "me", start: START, end: START + 5_000, text: "I'll send Dana the keys." },
        { side: "them", start: START + 5 * MIN, end: START + 5 * MIN + 5_000, text: "Can you book the room?" },
      ]);
      dismissed.dismiss({ recordingId: id, ...drop }, START);
      const invoke = vi.fn(async (_body: object) => ({
        content: [{ type: "tool_use", name: "record_action_items", input: { items: [{ turn: 1, text: "You: book the room" }] } }],
      }));
      const finder = new ActionItemFinder({ recordings, store: items, haiku: { invoke }, speakers: () => [], now: () => START + 10 * MIN });

      const report = await finder.refresh(id);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(report.items.map((item) => item.text)).toEqual(["You: book the room"]);
      dismissed.restore({ recordingId: id, ...drop });

      expect(items.getItems(id)?.items).toContainEqual(drop);
    });
  });

  describe("assertSuggestionRef", () => {
    it("should accept a real suggestion and refuse anything else", () => {
      expect(assertSuggestionRef({ recordingId: 3, saidAt: 5, text: "Do it", extra: 1 })).toEqual({ recordingId: 3, saidAt: 5, text: "Do it" });
      for (const bad of [
        null,
        "x",
        { recordingId: 0, saidAt: 5, text: "Do it" },
        { recordingId: 1.5, saidAt: 5, text: "Do it" },
        { recordingId: 3, saidAt: Number.NaN, text: "Do it" },
        { recordingId: 3, saidAt: 5, text: "  " },
        { recordingId: 3, saidAt: 5, text: "x".repeat(MAX_SUGGESTION_CHARS + 1) },
      ]) {
        expect(() => assertSuggestionRef(bad)).toThrow();
      }
    });
  });
});
