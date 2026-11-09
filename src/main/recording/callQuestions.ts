import type { CallQuestion, CallQuestionRequest, CallQuestionSource, TranscriptLine } from "../../shared/ipc";
import { formatClock, transcriptText } from "../../shared/transcript";
import { localDayBounds } from "../activity/dayReport";
import type { HaikuClient } from "../calendar/BedrockHaiku";
import type { CalendarEvent } from "../calendar/meetingLinks";
import type { CallQuestionStore } from "./CallQuestionStore";
import { bestMeeting } from "./callMeeting";
import type { RecordingStore, StoredRecording } from "./RecordingStore";

/** Transcript text sent with one question, at most (~75k tokens), so a question stays quick and cheap. */
export const MAX_TRANSCRIPT_CHARS = 300_000;

/** Calls an "all calls" search sends, at most, best matches first. */
export const MAX_SEARCH_CALLS = 10;

/** Calls sent when a search finds nothing to go on. */
export const RECENT_CALLS = 5;

/** The longest answer Sonnet may write. */
const MAX_ANSWER_TOKENS = 2_000;

/** Words too common to search transcripts for. */
const STOP_WORDS = new Set(
  (
    "a an the and or but if of to in on at by for with from into about over after before during between " +
    "i me my mine we us our you your he she him her his they them their it its this that these those there here " +
    "is am are was were be been being do does did done have has had can could would should will shall may might must " +
    "what when where who whom whose which why how any all some each every no not yes so than then too very just also " +
    "say said says tell told ask asked talk talked mention mentioned discuss discussed get got go going " +
    "call calls meeting meetings today yesterday week weeks month last next ago recent recently anything something " +
    "please give list summarize summary"
  ).split(" "),
);

/** How Sonnet should answer. */
const SYSTEM_PROMPT = [
  "You answer questions about the user's recorded calls, using the transcripts given.",
  'In a transcript, "You" is the user\'s own microphone and "Them" is everyone else on the call (the transcript ' +
    "can't tell the other people apart). Transcripts were made by speech recognition, so some words may be misheard.",
  "Answer only from the transcripts. If they don't say, say so plainly. When it helps, name which call " +
    "(its meeting and date) a point came from.",
  "Be brief and plain. No Markdown: no headings, no bold; a list may use lines starting with \"- \".",
].join("\n");

/** What answering a question needs, injected for tests. */
export interface CallQuestionDeps {
  recordings: Pick<RecordingStore, "listRecordings" | "listLines" | "getRecording" | "searchLines" | "listTranscribedIds">;
  questions: Pick<CallQuestionStore, "insertQuestion">;
  /** The calendar's meetings in a time range, to name each call. */
  listMeetings(from: number, to: number): CalendarEvent[];
  /** Sonnet on Bedrock. */
  claude: Pick<HaikuClient, "invoke">;
  now(): number;
}

/** A call picked for a question, with its transcript. */
interface PickedCall {
  recording: StoredRecording;
  title: string | null;
  lines: TranscriptLine[];
}

/** The calls picked for a question, and how they were picked when that's worth saying. */
interface Picked {
  calls: PickedCall[];
  note: string | null;
}

/**
 * Answers a question about your calls: picks the calls its scope covers, sends their transcripts to Sonnet,
 * and saves the question with the answer, or with the error when asking failed.
 * @param deps The stores, the calendar and Sonnet.
 * @param request The question, its scope and the call or day.
 * @returns The saved question.
 */
export async function askAboutCalls(deps: CallQuestionDeps, request: CallQuestionRequest): Promise<CallQuestion> {
  const question = request.question.trim();
  if (question === "") {
    throw new Error("Type or say a question first.");
  }
  const picked = pickCalls(deps, request, question);
  if (picked.calls.length === 0) {
    throw new Error(emptyScopeMessage(deps, request));
  }
  const sources = picked.calls.map(
    (call): CallQuestionSource => ({ recordingId: call.recording.id, start: call.recording.start, title: call.title }),
  );
  const askedAt = deps.now();
  let answer: string | null = null;
  let error: string | null = null;
  try {
    answer = readAnswer(await deps.claude.invoke(buildRequest(question, picked.calls, askedAt)));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return deps.questions.insertQuestion({ askedAt, question, scope: request.scope, sources, note: picked.note, answer, error });
}

/**
 * Picks the calls a question covers: the one call, the picked day's calls, or for "all" the calls that
 * mention its words (best matches first), then trims them to fit the size limit.
 * @param deps The stores and the calendar.
 * @param request The request.
 * @param question The question, trimmed.
 * @returns The calls, oldest first, and a note on how they were picked.
 */
export function pickCalls(deps: CallQuestionDeps, request: CallQuestionRequest, question: string): Picked {
  if (request.scope === "call") {
    const recording = request.recordingId === null ? null : deps.recordings.getRecording(request.recordingId);
    return fitToLimit(deps, recording ? [recording] : [], null);
  }
  if (request.scope === "day") {
    const { dayStart, dayEnd } = localDayBounds(request.at);
    // Newest first, so on a heavy day the size limit drops the morning rather than the call just had.
    return fitToLimit(deps, deps.recordings.listRecordings(dayStart, dayEnd).reverse(), null);
  }
  return searchCalls(deps, question);
}

/**
 * Says why there was nothing to send.
 * @param deps The stores.
 * @param request The request.
 * @returns The message to show.
 */
function emptyScopeMessage(deps: CallQuestionDeps, request: CallQuestionRequest): string {
  if (request.scope !== "call") {
    return "There are no transcribed calls to ask about yet.";
  }
  const exists = request.recordingId !== null && deps.recordings.getRecording(request.recordingId) !== null;
  return exists ? "That call has no words transcribed yet; try again in a moment." : "That call isn't recorded any more.";
}

/**
 * Builds the Messages API request: the transcripts, oldest first, then today's date and the question.
 * @param question The question.
 * @param calls The calls.
 * @param now The current time, so "yesterday" means something.
 * @returns The request body.
 */
export function buildRequest(question: string, calls: PickedCall[], now: number): object {
  const transcripts = calls
    .map((call) => {
      const end = call.recording.end === null ? "still going" : formatClock(call.recording.end);
      const meeting = call.title === null ? "" : ` meeting="${call.title.replace(/"/g, "'")}"`;
      return (
        `<call date="${longDate(call.recording.start)}" time="${formatClock(call.recording.start)} to ${end}"${meeting}>\n` +
        `${transcriptText(call.lines)}\n</call>`
      );
    })
    .join("\n\n");
  return {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: MAX_ANSWER_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${transcripts}\n\nToday is ${longDate(now)}, ${formatClock(now)}.\n\nQuestion: ${question}`,
      },
    ],
  };
}

/**
 * Reads the answer's text out of Sonnet's reply.
 * @param reply The parsed Messages API reply.
 * @returns The text.
 */
export function readAnswer(reply: unknown): string {
  const content = (reply as { content?: { type?: unknown; text?: unknown }[] } | null)?.content;
  const text = Array.isArray(content)
    ? content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("")
        .trim()
    : "";
  if (text === "") {
    throw new Error("Sonnet sent back an empty answer.");
  }
  return text;
}

/**
 * Loads the calls' transcripts, best first, until the size limit; puts them in time order. A call with no
 * transcript yet is left out. A single call longer than the limit keeps its latest part.
 * @param deps The stores and the calendar.
 * @param recordings The calls, best first.
 * @param note The note so far.
 * @param titles The calls' meeting titles, when already looked up.
 * @returns The picked calls.
 */
function fitToLimit(
  deps: CallQuestionDeps,
  recordings: StoredRecording[],
  note: string | null,
  titles: Map<number, string | null> = titleCalls(deps, recordings),
): Picked {
  const calls: PickedCall[] = [];
  let size = 0;
  let dropped = 0;
  let cut = false;
  for (const recording of recordings) {
    let lines = deps.recordings.listLines(recording.id);
    if (lines.length === 0) {
      continue;
    }
    const length = transcriptText(lines).length;
    if (calls.length === 0 && length > MAX_TRANSCRIPT_CHARS) {
      lines = latestLines(lines, MAX_TRANSCRIPT_CHARS);
      cut = true;
    } else if (size + length > MAX_TRANSCRIPT_CHARS) {
      dropped++;
      continue;
    }
    size += transcriptText(lines).length;
    calls.push({ recording, title: titles.get(recording.id) ?? null, lines });
  }
  const notes = [note];
  if (cut) {
    notes.push("That call is long, so only its latest part was sent.");
  }
  if (dropped > 0) {
    notes.push(`${dropped} more ${dropped === 1 ? "call was" : "calls were"} left out to keep it short.`);
  }
  calls.sort((a, b) => a.recording.start - b.recording.start);
  return { calls, note: notes.filter(Boolean).join(" ") || null };
}

/**
 * Finds the calls that mention a question's words, in the transcript or the meeting's title. With none, falls
 * back to the most recent calls and says so.
 * @param deps The stores and the calendar.
 * @param question The question.
 * @returns The picked calls.
 */
function searchCalls(deps: CallQuestionDeps, question: string): Picked {
  const now = deps.now();
  const transcribed = deps.recordings.listTranscribedIds();
  const all = deps.recordings.listRecordings(0, now + 1).filter((recording) => transcribed.has(recording.id));
  const titles = titleCalls(deps, all);
  const words = searchWords(question);
  const hits = deps.recordings.searchLines(words);
  const scored = all
    .map((recording) => {
      const found = new Set(hits.get(recording.id)?.words ?? []);
      const title = (titles.get(recording.id) ?? "").toLowerCase();
      for (const word of words) {
        if (title.includes(word)) {
          found.add(word);
        }
      }
      return { recording, words: found.size, lines: hits.get(recording.id)?.lines ?? 0 };
    })
    .filter((item) => item.words > 0)
    .sort((a, b) => b.words - a.words || b.lines - a.lines || b.recording.start - a.recording.start);
  const quoted = `"${words.join(", ")}"`;
  if (scored.length === 0) {
    const recent = all.slice(-RECENT_CALLS).reverse();
    const why = words.length === 0 ? "Your question had no words to search for" : `No calls mention ${quoted}`;
    return fitToLimit(deps, recent, `${why}, so these are your ${recent.length} most recent calls.`, titles);
  }
  const kept = scored.slice(0, MAX_SEARCH_CALLS).map((item) => item.recording);
  const more = scored.length - kept.length;
  const note =
    `Searched your calls for ${quoted}: ${scored.length} matched` +
    (more > 0 ? `; sent the ${kept.length} best matches.` : ".");
  return fitToLimit(deps, kept, note, titles);
}

/**
 * Writes a date in full.
 * @param ms The moment.
 * @returns e.g. "Monday, November 9, 2026".
 */
function longDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

/**
 * Names each call after the meeting it overlapped most.
 * @param deps The calendar.
 * @param recordings The calls.
 * @returns Each call's meeting title, or null.
 */
function titleCalls(deps: CallQuestionDeps, recordings: StoredRecording[]): Map<number, string | null> {
  const titles = new Map<number, string | null>();
  if (recordings.length === 0) {
    return titles;
  }
  const now = deps.now();
  const from = Math.min(...recordings.map((recording) => recording.start));
  const to = Math.max(...recordings.map((recording) => recording.end ?? now));
  const meetings = deps.listMeetings(from, to).filter((meeting) => meeting.response !== "declined");
  for (const recording of recordings) {
    titles.set(recording.id, bestMeeting(recording, meetings, now)?.title ?? null);
  }
  return titles;
}

/**
 * Keeps the end of a transcript that is too long, since the latest part of a call matters most.
 * @param lines The lines.
 * @param limit The most text to keep.
 * @returns The latest lines that fit.
 */
function latestLines(lines: TranscriptLine[], limit: number): TranscriptLine[] {
  const sorted = [...lines].sort((a, b) => a.start - b.start);
  let size = 0;
  let first = sorted.length;
  while (first > 0 && size + sorted[first - 1].text.length + 20 <= limit) {
    first--;
    size += sorted[first].text.length + 20;
  }
  return sorted.slice(first);
}

/**
 * Picks the words of a question worth searching for: lower case, without common words, short words or
 * repeats, and with a plural "s" taken off so "webhooks" finds "webhook".
 * @param question The question.
 * @returns The words.
 */
export function searchWords(question: string): string[] {
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
    .map((word) => (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
  return [...new Set(words)];
}
