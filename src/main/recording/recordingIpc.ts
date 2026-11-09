import { ipcMain } from "electron";
import {
  CALL_QUESTION_SCOPES,
  IPC,
  type CallQuestion,
  type CallQuestionRequest,
  type CallQuestionScope,
  type CallRecording,
  type RecordingsReport,
} from "../../shared/ipc";
import { localDayBounds } from "../activity/dayReport";
import type { CalendarEvent } from "../calendar/meetingLinks";
import { assertMoment, assertRowId } from "../ipcHandlers";
import { bestMeeting } from "./callMeeting";
import type { RecordingStore } from "./RecordingStore";
import type { Transcriber } from "./Transcriber";

/** What the recordings requests are answered from. */
export interface RecordingIpcDependencies {
  store: Pick<RecordingStore, "listRecordings" | "listLines" | "getRecording">;
  transcriber: Pick<Transcriber, "waiting" | "currentProblem">;
  /** The calendar's meetings in a time range, to name each call. */
  listMeetings(from: number, to: number): CalendarEvent[];
  /** Shows a file (selected in its folder) or a folder in Finder. */
  showInFinder(path: string): void;
  /** How many chunks in a recording's folder whisper couldn't read. */
  countUnread(folder: string): number;
  /** Asks Sonnet a checked question and saves it with the answer. */
  ask(request: CallQuestionRequest): Promise<CallQuestion>;
  /** The questions asked before, newest first. */
  listQuestions(): CallQuestion[];
  /** Turns dictated speech (WAV bytes) into text. */
  dictate(wav: Uint8Array): Promise<string>;
  now(): number;
}

/** The longest question accepted, typed or dictated. */
export const MAX_QUESTION_CHARS = 2_000;

/** The biggest dictation accepted: a bit over two minutes of 16 kHz 16-bit mono. */
export const MAX_DICTATION_BYTES = 5_000_000;

/**
 * Answers the Today screen's requests for the day's calls and their transcripts.
 * @param deps The services to answer from.
 */
export function registerRecordingIpc(deps: RecordingIpcDependencies): void {
  ipcMain.handle(IPC.getRecordings, (_event, at: unknown) => buildRecordingsReport(deps, assertMoment(at)));
  ipcMain.handle(IPC.showRecordingAudio, (_event, id: unknown) => {
    const recording = deps.store.getRecording(assertRowId(id));
    if (!recording || recording.audioDeleted) {
      throw new Error("That call's audio is no longer on this Mac.");
    }
    // The named file once it exists; until then (still mixing) the working folder.
    deps.showInFinder(recording.audioPath ?? recording.folder);
  });
  ipcMain.handle(IPC.askAboutCalls, (_event, request: unknown) => deps.ask(assertQuestionRequest(request)));
  ipcMain.handle(IPC.getCallQuestions, () => deps.listQuestions());
  ipcMain.handle(IPC.transcribeDictation, (_event, wav: unknown) => deps.dictate(assertDictation(wav)));
}

/**
 * Checks a question sent by the renderer.
 * @param value What it sent.
 * @returns The request, typed.
 */
export function assertQuestionRequest(value: unknown): CallQuestionRequest {
  const request = value as Partial<CallQuestionRequest> | null;
  if (typeof request !== "object" || request === null) {
    throw new Error("Not a question.");
  }
  if (typeof request.question !== "string" || request.question.length > MAX_QUESTION_CHARS) {
    throw new Error(`A question can be up to ${MAX_QUESTION_CHARS} characters.`);
  }
  if (!CALL_QUESTION_SCOPES.includes(request.scope as CallQuestionScope)) {
    throw new Error("Choose this call, this day or all calls.");
  }
  const recordingId = request.recordingId === null || request.recordingId === undefined ? null : assertRowId(request.recordingId);
  if (request.scope === "call" && recordingId === null) {
    throw new Error("Choose a call to ask about.");
  }
  return { question: request.question, scope: request.scope as CallQuestionScope, at: assertMoment(request.at), recordingId };
}

/**
 * Checks dictated audio sent by the renderer: a WAV file, not too big.
 * @param value What it sent.
 * @returns The bytes.
 */
export function assertDictation(value: unknown): Uint8Array {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : null;
  if (!bytes || bytes.byteLength < 44 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "RIFF") {
    throw new Error("That recording wasn't a WAV file.");
  }
  if (bytes.byteLength > MAX_DICTATION_BYTES) {
    throw new Error("That recording is too long; keep a question under two minutes.");
  }
  return bytes;
}

/**
 * Collects the day's calls with their transcripts and the meeting each overlapped most.
 * @param deps The services.
 * @param at A moment in the day.
 * @returns The report.
 */
export function buildRecordingsReport(
  deps: Pick<RecordingIpcDependencies, "store" | "transcriber" | "listMeetings" | "countUnread" | "now">,
  at: number,
): RecordingsReport {
  const { dayStart, dayEnd } = localDayBounds(at);
  const meetings = deps.listMeetings(dayStart, dayEnd).filter((meeting) => meeting.response !== "declined");
  const recordings = deps.store.listRecordings(dayStart, dayEnd).map(
    (recording): CallRecording => ({
      id: recording.id,
      start: recording.start,
      end: recording.end,
      meetingTitle: bestMeeting(recording, meetings, deps.now())?.title ?? null,
      mic: recording.mic,
      error: recording.error,
      audioKept: !recording.audioDeleted,
      waitingChunks: deps.transcriber.waiting(recording.id),
      unreadChunks: recording.audioDeleted ? 0 : deps.countUnread(recording.folder),
      lines: deps.store.listLines(recording.id),
    }),
  );
  return { recordings, transcriberProblem: deps.transcriber.currentProblem() };
}
