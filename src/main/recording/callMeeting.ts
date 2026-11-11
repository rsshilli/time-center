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
  const real = meetings.filter(isRealMeeting);
  return mostOverlapping(recording, real, now) ?? mostOverlapping(recording, meetings, now);
}

/**
 * Whether now is time you blocked out for yourself ("Ryan gets things done"): some meeting you haven't declined is
 * on, and none of them has anyone else on it or a call link. The microphone in use then is you dictating, not a call.
 * @param meetings Meetings around now.
 * @param now The current time.
 * @returns True when a call starting now shouldn't be recorded.
 */
export function isSoloTime(meetings: CalendarEvent[], now: number): boolean {
  const on = meetings.filter((meeting) => meeting.start <= now && now < meeting.end && meeting.response !== "declined");
  return on.length > 0 && !on.some(isRealMeeting);
}

/**
 * Whether a meeting is one with other people: anyone else invited, or a call link to join.
 * @param meeting The meeting.
 * @returns True for a real meeting, false for a block you put in for yourself.
 */
function isRealMeeting(meeting: CalendarEvent): boolean {
  return meeting.attendees.length > 0 || meeting.provider !== null;
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
