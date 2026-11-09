import type { CallRecording, TranscriptLine } from "../../src/shared/ipc";
import { dropEchoes, groupTurns, transcriptText } from "../../src/shared/transcript";
import { stateText } from "../../src/renderer/RecordingsCard";

const NINE = new Date(2026, 10, 6, 9, 30).getTime();

/**
 * A transcript line.
 * @param side Who.
 * @param seconds When, in seconds after 9:30.
 * @param text What.
 * @returns The line.
 */
const line = (side: "me" | "them", seconds: number, text: string): TranscriptLine => ({
  side,
  start: NINE + seconds * 1000,
  end: NINE + seconds * 1000 + 500,
  text,
});

describe("groupTurns", () => {
  it("should join what each side said in a row, in the order it was said", () => {
    const turns = groupTurns([line("them", 5, "Sounds good."), line("me", 0, "Hi."), line("me", 2, "Ready?")]);
    expect(turns.map((turn) => [turn.side, turn.text])).toEqual([
      ["me", "Hi. Ready?"],
      ["them", "Sounds good."],
    ]);
  });
});

describe("dropEchoes", () => {
  it("should leave out the speakers heard by your microphone, using the lines from the live check", () => {
    // From the 2026-11-09 live check: the Mac's speakers, picked up by the MacBook microphone.
    const lines = [
      line("them", 0, "Good morning. This is the live test of Time Center. Please file a Jira ticket for the budget review by Friday."),
      line("me", 0, "Good morning. This is the live test of Time Center."),
      line("me", 4, "Please file a JIRA ticket for the budget review by Friday."),
      line("them", 15, "Thanks, I will send the QBD Vision release notes after lunch."),
      line("me", 15, "Thanks. I will send the QBDVision release notes after launch."),
      line("me", 30, "Actually, can we move that to Monday?"),
    ];
    expect(dropEchoes(lines).map((kept) => [kept.side, kept.text.slice(0, 12)])).toEqual([
      ["them", "Good morning"],
      ["them", "Thanks, I wi"],
      ["me", "Actually, ca"],
    ]);
  });

  it("should keep a short reply even when its words are in what they just said", () => {
    const lines = [line("them", 0, "Okay, so are we good to ship it?"), line("me", 2, "Yeah, good.")];
    expect(dropEchoes(lines)).toHaveLength(2);
  });

  it("should keep your own words even when they repeat theirs much later", () => {
    const lines = [line("them", 0, "Ship it on Friday."), line("me", 60, "Ship it on Friday.")];
    expect(dropEchoes(lines)).toHaveLength(2);
  });
});

describe("transcriptText", () => {
  it("should write one turn per line with its time and speaker", () => {
    expect(transcriptText([line("me", 0, "Hi."), line("them", 61, "Hello.")])).toMatch(/^9:30\sAM You: Hi\.\n9:31\sAM Them: Hello\.$/);
  });
});

describe("stateText", () => {
  const call = (fields: Partial<CallRecording>): CallRecording => ({
    id: 1,
    start: NINE,
    end: NINE + 60_000,
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

  it("should say whether the call is recording, being transcribed, or had nothing said", () => {
    expect(stateText(call({ end: null }))).toBe("● Recording now");
    expect(stateText(call({ waitingChunks: 1 }))).toBe("Transcribing (1 piece left)");
    expect(stateText(call({}))).toBe("Nothing said");
    expect(stateText(call({ unreadChunks: 2 }))).toBe("Couldn't be transcribed");
    expect(stateText(call({ lines: [line("me", 0, "Hi.")] }))).toBe("");
  });
});
