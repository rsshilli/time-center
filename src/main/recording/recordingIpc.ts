import { BrowserWindow, ipcMain } from "electron";
import {
  CALL_QUESTION_SCOPES,
  IPC,
  type ActionItemsReport,
  type CallQuestion,
  type CallQuestionRequest,
  type CallQuestionScope,
  type CallRecording,
  type RecordingsReport,
} from "../../shared/ipc";
import { localDayBounds } from "../activity/dayReport";
import type { CalendarEvent } from "../calendar/meetingLinks";
import { assertMoment, assertRowId } from "../ipcHandlers";
import { describeSpeakers, nameChoices } from "../speakers/speakerIpc";
import type { SpeakerStore } from "../speakers/SpeakerStore";
import type { ActionItemStore } from "./ActionItemStore";
import { callSections, callTitle, WINDOWS_BEFORE_MS, type CallWindow } from "./callMeeting";
import type { RecordingStore } from "./RecordingStore";
import type { Transcriber } from "./Transcriber";

/** What the recordings requests are answered from. */
export interface RecordingIpcDependencies {
  store: Pick<RecordingStore, "listRecordings" | "listLines" | "getRecording">;
  transcriber: Pick<Transcriber, "waiting" | "currentProblem">;
  /** The calendar's meetings in a time range, to name each call. */
  listMeetings(from: number, to: number): CalendarEvent[];
  /** The front windows in a time range, to tell which meeting a call was in when two overlap. */
  listWindows(from: number, to: number): CallWindow[];
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
  /** Each call's saved action items. */
  actionItems: Pick<ActionItemStore, "getItems">;
  /** Each call's speakers, and the people you've named. */
  speakers: Pick<SpeakerStore, "listSpeakers" | "listVoices">;
  /** Brings a call's action items up to date with Haiku, when it's time to. */
  refreshActionItems(recordingId: number): Promise<ActionItemsReport>;
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
  ipcMain.handle(IPC.refreshActionItems, (event, id: unknown) => {
    // Haiku reads a call only while you can see it: a hidden or minimized window asking is refused.
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window?.isVisible() || window.isMinimized()) {
      throw new Error("Action items are only looked for while the window is in view.");
    }
    return deps.refreshActionItems(assertRowId(id));
  });
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
 * Collects the day's calls with their transcripts and the meetings each ran through.
 * @param deps The services.
 * @param at A moment in the day.
 * @returns The report.
 */
export function buildRecordingsReport(
  deps: Pick<RecordingIpcDependencies, "store" | "transcriber" | "listMeetings" | "listWindows" | "countUnread" | "actionItems" | "speakers" | "now">,
  at: number,
): RecordingsReport {
  const { dayStart, dayEnd } = localDayBounds(at);
  const meetings = deps.listMeetings(dayStart, dayEnd).filter((meeting) => meeting.response !== "declined");
  const windows = deps.listWindows(dayStart - WINDOWS_BEFORE_MS, dayEnd);
  const voices = deps.speakers.listVoices();
  const names = new Map(voices.map((voice) => [voice.id, voice.name]));
  const recordings = deps.store.listRecordings(dayStart, dayEnd).map((recording): CallRecording => {
    const lines = deps.store.listLines(recording.id);
    const saved = deps.actionItems.getItems(recording.id);
    const sections = callSections(recording, meetings, windows, deps.now());
    const invitees = sections.flatMap((section) => section.meeting.attendees);
    return {
      id: recording.id,
      start: recording.start,
      end: recording.end,
      meetingTitle: callTitle(sections),
      meetings: sections.map((section) => ({ title: section.meeting.title, start: section.start })),
      mic: recording.mic,
      error: recording.error,
      audioKept: !recording.audioDeleted,
      waitingChunks: deps.transcriber.waiting(recording.id),
      unreadChunks: recording.audioDeleted ? 0 : deps.countUnread(recording.folder),
      lines,
      speakers: describeSpeakers(deps.speakers.listSpeakers(recording.id), names),
      nameChoices: nameChoices(invitees,voices.map((voice) => voice.name)),
      actionItems: saved?.items ?? [],
      actionItemsBehind: saved !== null && lines.length > saved.coveredLines,
    };
  });
  return { recordings, transcriberProblem: deps.transcriber.currentProblem() };
}
