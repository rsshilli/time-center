import type { CalendarEvent } from "../calendar/meetingLinks";
import type { StoredRecording } from "./RecordingStore";

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
