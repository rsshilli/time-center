import { CallQuestionStore } from "../../src/main/recording/CallQuestionStore";
import {
  MAX_SEARCH_CALLS,
  MAX_TRANSCRIPT_CHARS,
  askAboutCalls,
  buildRequest,
  clockInCall,
  splitTodos,
  pickCalls,
  readAnswer,
  searchWords,
  type CallQuestionDeps,
} from "../../src/main/recording/callQuestions";
import { RecordingStore } from "../../src/main/recording/RecordingStore";
import type { CalendarEvent } from "../../src/main/calendar/meetingLinks";
import { Store } from "../../src/main/store/Store";
import type { CallQuestionRequest } from "../../src/shared/ipc";

const MON = new Date(2026, 10, 9, 9).getTime();
const TUE = new Date(2026, 10, 10, 9).getTime();
const MIN = 60_000;

/** A finished call with one line per text, a minute apart. */
function addCall(recordings: RecordingStore, start: number, texts: string[], side: "me" | "them" = "them"): number {
  const id = recordings.insertRecording(start, "/tmp/none");
  recordings.finishRecording(id, start + 30 * MIN);
  recordings.insertLines(id, texts.map((text, i) => ({ side, start: start + i * MIN, end: start + i * MIN + 5_000, text })));
  return id;
}

/** A calendar meeting covering a call. */
function meeting(title: string, start: number): CalendarEvent {
  return { eventId: title, title, start, end: start + 30 * MIN, response: "accepted", provider: "zoom", joinUrl: null, seriesId: title, attendees: [] };
}

describe("callQuestions", () => {
  let store: Store;
  let recordings: RecordingStore;
  let questions: CallQuestionStore;
  let meetings: CalendarEvent[];
  let invoke: ReturnType<typeof vi.fn<(body: object) => Promise<unknown>>>;
  let deps: CallQuestionDeps;

  beforeEach(() => {
    store = new Store(":memory:");
    recordings = new RecordingStore(store.db);
    questions = new CallQuestionStore(store.db);
    meetings = [];
    invoke = vi.fn<(body: object) => Promise<unknown>>(async () => ({ content: [{ type: "text", text: "  Dana wants test cards for Europe.  " }] }));
    deps = { recordings, questions, listMeetings: () => meetings, listWindows: () => [], claude: { invoke }, speakers: () => [], now: () => TUE + 8 * 60 * MIN };
  });

  afterEach(() => {
    store.close();
  });

  /** A request with defaults. */
  const ask = (question: string, scope: CallQuestionRequest["scope"], extra: Partial<CallQuestionRequest> = {}) => ({
    question,
    scope,
    at: MON,
    recordingId: null,
    ...extra,
  });

  it("should send the call's transcript and save the question with Sonnet's answer, trimmed", async () => {
    const id = addCall(recordings, MON, ["Can we get test cards for Europe?"]);
    meetings = [meeting("Northwind onboarding", MON)];

    const saved = await askAboutCalls(deps, ask("  What did they ask for? ", "call", { recordingId: id }));

    expect(saved.answer).toBe("Dana wants test cards for Europe.");
    expect(saved.error).toBeNull();
    expect(saved.question).toBe("What did they ask for?");
    expect(saved.sources).toEqual([{ recordingId: id, start: MON, title: "Northwind onboarding" }]);
    const body = invoke.mock.calls[0][0] as { messages: { content: string }[] };
    expect(body.messages[0].content).toContain("Them: Can we get test cards for Europe?");
    expect(body.messages[0].content).toContain('meeting="Northwind onboarding"');
    expect(questions.listQuestions(10)).toEqual([saved]);
  });

  it("should save the error when Bedrock fails, so the question isn't lost", async () => {
    const id = addCall(recordings, MON, ["Hello"]);
    invoke.mockRejectedValueOnce(new Error("Bedrock said: throttled"));

    const saved = await askAboutCalls(deps, ask("Anything?", "call", { recordingId: id }));

    expect(saved.answer).toBeNull();
    expect(saved.error).toBe("Bedrock said: throttled");
    expect(questions.listQuestions(10)[0].error).toBe("Bedrock said: throttled");
  });

  it("should refuse an empty question and a scope with no calls, without calling Sonnet", async () => {
    await expect(askAboutCalls(deps, ask("   ", "day"))).rejects.toThrow(/question first/);
    await expect(askAboutCalls(deps, ask("Hi?", "day"))).rejects.toThrow(/no transcribed calls/);
    await expect(askAboutCalls(deps, ask("Hi?", "call", { recordingId: 99 }))).rejects.toThrow(/isn't recorded/);
    const silent = recordings.insertRecording(MON, "/tmp/none");
    await expect(askAboutCalls(deps, ask("Hi?", "call", { recordingId: silent }))).rejects.toThrow(/no words transcribed yet/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("should keep the newest of a day's calls when they don't all fit", () => {
    const line = "x".repeat(1_000);
    const half = Array.from({ length: Math.ceil(MAX_TRANSCRIPT_CHARS / 2_000) + 10 }, () => line);
    addCall(recordings, MON, half);
    const later = addCall(recordings, MON + 120 * MIN, half);

    const picked = pickCalls(deps, ask("x", "day"), "x");

    expect(picked.calls.map((call) => call.recording.id)).toEqual([later]);
    expect(picked.note).toBe("1 more call was left out to keep it short.");
  });

  it("should leave calls with no transcript out of the search and its fallback, and out of the counts", () => {
    meetings = [meeting("Budget review", TUE)];
    recordings.insertRecording(TUE, "/tmp/none");
    const old = addCall(recordings, MON, ["Hello"]);

    const matched = pickCalls(deps, ask("budget", "all"), "budget");
    const fallback = pickCalls(deps, ask("zebras", "all"), "zebras");

    expect(matched.calls.map((call) => call.recording.id)).toEqual([old]);
    expect(matched.note).toBe('No calls mention "budget", so these are your 1 most recent calls.');
    expect(fallback.calls.map((call) => call.recording.id)).toEqual([old]);
  });

  it("should take only the picked day's calls for this day, oldest first, skipping calls with no transcript yet", () => {
    const second = addCall(recordings, MON + 120 * MIN, ["Later"]);
    const first = addCall(recordings, MON, ["Earlier"]);
    recordings.insertRecording(MON + 240 * MIN, "/tmp/none");
    addCall(recordings, TUE, ["Next day"]);

    const picked = pickCalls(deps, ask("x", "day"), "x");

    expect(picked.calls.map((call) => call.recording.id)).toEqual([first, second]);
    expect(picked.note).toBeNull();
  });

  it("should search all calls for the question's words, in transcripts and meeting titles, best match first", () => {
    const both = addCall(recordings, MON, ["The webhooks failed", "Northwind wants sandbox keys"]);
    const titleOnly = addCall(recordings, TUE, ["Hi there"]);
    addCall(recordings, TUE + 60 * MIN, ["Nothing relevant"]);
    meetings = [meeting("Northwind onboarding", TUE)];

    const picked = pickCalls(deps, ask("What did Northwind say about webhooks?", "all"), "What did Northwind say about webhooks?");

    expect(picked.calls.map((call) => call.recording.id)).toEqual([both, titleOnly]);
    expect(picked.note).toBe('Searched your calls for "northwind, webhook": 2 matched.');
  });

  it("should fall back to the most recent calls, and say so, when no call mentions the words", () => {
    for (let day = 0; day < 7; day++) {
      addCall(recordings, MON - day * 24 * 60 * MIN, [`Day ${day}`]);
    }

    const picked = pickCalls(deps, ask("Any zebras?", "all"), "Any zebras?");

    expect(picked.calls).toHaveLength(5);
    expect(picked.calls.at(-1)?.recording.start).toBe(MON);
    expect(picked.note).toBe('No calls mention "zebra", so these are your 5 most recent calls.');
  });

  it("should send at most the best matches, and say how many matched", () => {
    for (let i = 0; i < MAX_SEARCH_CALLS + 2; i++) {
      addCall(recordings, MON + i * 60 * MIN, ["budget talk"]);
    }

    const picked = pickCalls(deps, ask("budget", "all"), "budget");

    expect(picked.calls).toHaveLength(MAX_SEARCH_CALLS);
    expect(picked.note).toBe(`Searched your calls for "budget": ${MAX_SEARCH_CALLS + 2} matched; sent the ${MAX_SEARCH_CALLS} best matches.`);
  });

  it("should keep only the latest part of a call too long to send whole", () => {
    const line = "x".repeat(1_000);
    const lines = Math.ceil(MAX_TRANSCRIPT_CHARS / 1_000);
    const id = addCall(recordings, MON, Array.from({ length: lines }, (_, i) => `${i} ${line}`));

    const picked = pickCalls(deps, ask("x", "call", { recordingId: id }), "x");

    expect(picked.calls).toHaveLength(1);
    expect(picked.calls[0].lines.at(-1)?.text.startsWith(`${lines - 1} `)).toBe(true);
    expect(picked.calls[0].lines.length).toBeLessThan(lines);
    expect(picked.note).toBe("That call is long, so only its latest part was sent.");
  });

  it("should pick search words without common words, short words, repeats or plural s", () => {
    expect(searchWords("What did Dana say about the webhooks and Webhooks, in Q4's budget?")).toEqual(["dana", "webhook", "budget"]);
    expect(searchWords("What happened?")).toEqual(["happened"]);
    expect(searchWords("Did we discuss access?")).toEqual(["access"]);
  });

  it("should tell Sonnet today's date and mark a call still going", () => {
    const id = recordings.insertRecording(MON, "/tmp/none");
    const body = buildRequest("What now?", [{ recording: recordings.getRecording(id)!, title: 'Say "hi"', lines: [], speakers: [] }], MON) as {
      messages: { content: string }[];
    };
    expect(body.messages[0].content).toContain("Today is Monday, November 9, 2026");
    expect(body.messages[0].content).toContain("to still going");
    expect(body.messages[0].content).toContain(`meeting="Say 'hi'"`);
    expect(body.messages[0].content.endsWith("Question: What now?")).toBe(true);
  });

  it("should save the TODOs Sonnet lists with the question, off the answer, at the call and moment they came from", async () => {
    const id = addCall(recordings, MON, ["I'll send you a write-up, Ryan."]);
    invoke.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text:
            "Yes, Jack owes you a write-up.\n\n<todos>\n" +
            '<todo call="1" time="9:00 AM">Read Jack\'s write-up</todo>\n' +
            '<todo call="2" time="9:01 AM">From a call that was never sent</todo>\n' +
            '<todo call="1" time="noon">  </todo>\n</todos>',
        },
      ],
    });

    const saved = await askAboutCalls(deps, ask("Any tasks for me?", "call", { recordingId: id }));

    expect(saved.answer).toBe("Yes, Jack owes you a write-up.");
    expect(saved.todos).toEqual([{ text: "Read Jack's write-up", recordingId: id, saidAt: MON }]);
    expect(questions.listQuestions(5)[0].todos).toEqual(saved.todos);
    const body = invoke.mock.calls[0][0] as { system: string; messages: { content: string }[] };
    expect(body.messages[0].content).toContain('<call n="1" ');
    expect(body.system).toContain("<todos>");
  });

  it("should keep the finished TODOs of a list cut off mid-way, and no list at all when there is none", () => {
    const calls = [{ recording: { id: 4, start: MON } as never }];

    const cut = splitTodos('Two things.\n<todos>\n<todo call="1" time="9:30 AM">First</todo>\n<todo call="1">Sec', calls);

    expect(cut).toEqual({ answer: "Two things.", todos: [{ text: "First", recordingId: 4, saidAt: MON + 30 * MIN }] });
    expect(splitTodos("Nothing to do.", calls)).toEqual({ answer: "Nothing to do.", todos: [] });
  });

  it("should give a TODO with no call number to the only call sent, and decode its escapes", () => {
    const one = [{ recording: { id: 4, start: MON, end: null } as never }];
    const two = [...one, { recording: { id: 5, start: MON, end: null } as never }];
    const reply = 'Here.\n<todos><todo time="9:30 AM">Ask Q&amp;A about &lt;CAP&gt;</todo></todos>';

    expect(splitTodos(reply, one).todos).toEqual([{ text: "Ask Q&A about <CAP>", recordingId: 4, saidAt: MON + 30 * MIN }]);
    expect(splitTodos(reply, two).todos).toEqual([]);
  });

  it("should place a time of day in the call, past midnight too, and fall back to its start", () => {
    const late = new Date(2026, 10, 9, 23, 50).getTime();
    const open = (start: number) => ({ start, end: null });

    expect(clockInCall("11:55 PM", open(late))).toBe(late + 5 * MIN);
    expect(clockInCall("12:05 AM", { start: late, end: late + 30 * MIN })).toBe(new Date(2026, 10, 10, 0, 5).getTime());
    expect(clockInCall("13:32", open(MON))).toBe(new Date(2026, 10, 9, 13, 32).getTime());
    expect(clockInCall("9:00 AM", open(MON + 30_000))).toBe(MON);
    expect(clockInCall("soon", open(MON))).toBe(MON);
    expect(clockInCall("25:00", open(MON))).toBe(MON);
  });

  it("should fall back to the call's start for a time outside the call", () => {
    const call = { start: MON, end: MON + 30 * MIN };

    expect(clockInCall("8:55 AM", call)).toBe(MON);
    expect(clockInCall("3:00 PM", call)).toBe(MON);
    expect(clockInCall("9:30 AM", call)).toBe(MON + 30 * MIN);
  });

  it("should read the text blocks of a reply and refuse an empty one", () => {
    expect(readAnswer({ content: [{ type: "text", text: "A" }, { type: "tool_use" }, { type: "text", text: "B" }] })).toBe("AB");
    expect(() => readAnswer({ content: [] })).toThrow(/empty answer/);
    expect(() => readAnswer(null)).toThrow(/empty answer/);
  });
});
