import { ipcMain } from "electron";
import { IPC, type CallRecording, type RecordingsReport } from "../../shared/ipc";
import { localDayBounds } from "../activity/dayReport";
import type { CalendarEvent } from "../calendar/meetingLinks";
import { assertMoment, assertRowId } from "../ipcHandlers";
import type { RecordingStore, StoredRecording } from "./RecordingStore";
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
  now(): number;
}

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
}

/**
 * Collects the day's calls with their transcripts and the meeting each overlapped most.
 * @param deps The services.
 * @param at A moment in the day.
 * @returns The report.
 */
export function buildRecordingsReport(deps: RecordingIpcDependencies, at: number): RecordingsReport {
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

/**
 * Finds the meeting a call overlapped most.
 * @param recording The call.
 * @param meetings The day's meetings.
 * @param now The current time, the end of a call still going.
 * @returns The meeting, or null when none overlapped.
 */
export function bestMeeting(recording: StoredRecording, meetings: CalendarEvent[], now: number): CalendarEvent | null {
  // A real meeting (other people, or a call link) beats a block you put in for yourself ("Pay credit card!").
  const real = meetings.filter((meeting) => meeting.attendees.length > 0 || meeting.provider !== null);
  return mostOverlapping(recording, real, now) ?? mostOverlapping(recording, meetings, now);
}

/**
 * Finds the meeting that overlaps a call the longest.
 * @param recording The call.
 * @param meetings The candidates.
 * @param now The current time, the end of a call still going.
 * @returns The meeting, or null when none overlapped.
 */
function mostOverlapping(recording: StoredRecording, meetings: CalendarEvent[], now: number): CalendarEvent | null {
  const end = recording.end ?? now;
  let best: CalendarEvent | null = null;
  let bestOverlap = 0;
  for (const meeting of meetings) {
    const overlap = Math.min(end, meeting.end) - Math.max(recording.start, meeting.start);
    if (overlap > bestOverlap) {
      best = meeting;
      bestOverlap = overlap;
    }
  }
  return best;
}
