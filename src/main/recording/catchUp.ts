import { CATCH_UP_MINUTES, type CallSpeaker, type CatchUp, type CatchUpMinutes } from "../../shared/ipc";
import { formatClock, groupTurns, speakerLabel } from "../../shared/transcript";
import type { HaikuClient } from "../calendar/BedrockHaiku";
import { latestTurns, MAX_TRANSCRIPT_CHARS } from "./actionItems";
import type { RecordingStore } from "./RecordingStore";

/** What Haiku is asked to do with the last few minutes. */
const SYSTEM_PROMPT = [
  "The user is on a call and stopped paying attention for a few minutes. Catch them up on the part of the " +
    "transcript you're given, so they can jump back in.",
  'In the transcript, "You" is the user\'s own microphone and "Them" is everyone else unless a name is given ' +
    "(speech recognition may mishear words).",
  "Start with anything someone asked the user, or is waiting on them for, if there is any. Then what was " +
    "decided, what the user was asked to do, and what's being talked about right now.",
  "Write at most 6 short bullet points starting with \"- \", in plain words. No heading, no preamble, nothing " +
    "made up: if little was said, say so in one bullet.",
].join("\n");

/** What catching up needs, injected for tests. */
export interface CatchUpDeps {
  recordings: Pick<RecordingStore, "getRecording" | "listLines">;
  /** Haiku on Bedrock. */
  haiku: Pick<HaikuClient, "invoke">;
  /** A call's speakers, so the transcript names who said what. */
  speakers(recordingId: number): CallSpeaker[];
  now(): number;
}

/**
 * Summarises the last few minutes of a call with Haiku: "I haven't been paying attention, catch me up." When
 * nothing was said in that time, says so without asking Haiku.
 * @param deps The recordings, Haiku and the clock.
 * @param recordingId The call.
 * @param minutes How far back: 2, 5 or 10 minutes.
 * @returns The summary and the stretch of the call it covers.
 */
export async function catchUp(deps: CatchUpDeps, recordingId: number, minutes: CatchUpMinutes): Promise<CatchUp> {
  const recording = deps.recordings.getRecording(recordingId);
  if (!recording) {
    throw new Error("That call isn't recorded.");
  }
  const to = recording.end ?? deps.now();
  const from = to - minutes * 60_000;
  const speakers = deps.speakers(recordingId);
  const lines = deps.recordings.listLines(recordingId).filter((line) => line.end > from);
  const turns = latestTurns(groupTurns(lines, speakers), MAX_TRANSCRIPT_CHARS);
  if (turns.length === 0) {
    return { minutes, from, to, summary: `Nothing was said in the last ${minutes} minutes.`, turns: 0 };
  }
  const reply = await deps.haiku.invoke(buildCatchUpRequest(turns, speakers, minutes));
  return { minutes, from, to, summary: readSummary(reply), turns: turns.length };
}

/**
 * Builds the request: the stretch of transcript and how long it is.
 * @param turns The turns said in that time, oldest first.
 * @param speakers The call's speakers, to name who said each turn.
 * @param minutes How many minutes they cover.
 * @returns The Messages API body.
 */
export function buildCatchUpRequest(turns: ReturnType<typeof groupTurns>, speakers: readonly CallSpeaker[], minutes: number): object {
  const transcript = turns.map((turn) => `${formatClock(turn.start)} ${speakerLabel(turn, speakers)}: ${turn.text}`).join("\n");
  return {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `The last ${minutes} minutes of the call:\n<transcript>\n${transcript}\n</transcript>` }],
  };
}

/**
 * Reads Haiku's summary from its reply.
 * @param reply Haiku's reply.
 * @returns The summary's text.
 */
export function readSummary(reply: unknown): string {
  const content = (reply as { content?: { type?: unknown; text?: unknown }[] } | null)?.content;
  const text = Array.isArray(content)
    ? content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n")
        .trim()
    : "";
  if (text === "") {
    throw new Error("Haiku didn't send back a summary.");
  }
  return text;
}

/**
 * Checks how far back the renderer asked to catch up.
 * @param value What it sent.
 * @returns The minutes: 2, 5 or 10.
 */
export function assertCatchUpMinutes(value: unknown): CatchUpMinutes {
  if (!CATCH_UP_MINUTES.includes(value as CatchUpMinutes)) {
    throw new Error(`Catch up on the last ${CATCH_UP_MINUTES.join(", ")} minutes.`);
  }
  return value as CatchUpMinutes;
}
