import { useState } from "react";
import { MEETING_TYPE_LABELS, meetingCategory, type DayMeeting, type MeetingType } from "../shared/ipc";
import { readableError } from "./CalendarSettings";
import { colourFor, formatDuration } from "./format";

/**
 * The day's calendar meetings with each one's type and the time it got. Picking a type corrects Haiku's
 * guess for every occurrence of that meeting, and the day is re-read so the Categories card moves too.
 * @param props.meetings The day's meetings.
 * @param props.onChanged Called after a type is changed.
 */
export function MeetingTypesCard({ meetings, onChanged }: { meetings: DayMeeting[]; onChanged: () => void }) {
  const [message, setMessage] = useState<string | null>(null);

  /**
   * Saves your pick for a meeting.
   * @param meeting The meeting.
   * @param type The type you picked.
   */
  const pick = async (meeting: DayMeeting, type: MeetingType) => {
    try {
      await window.timeCenter.setMeetingType(meeting.eventId, type);
      setMessage(`"${meeting.title}" is ${MEETING_TYPE_LABELS[type]} from now on, repeats included.`);
      onChanged();
    } catch (error) {
      setMessage(readableError(error));
    }
  };

  return (
    <div className="card meeting-types">
      <h2>Meetings</h2>
      <ul className="meeting-type-list">
        {meetings.map((meeting) => (
          <li key={`${meeting.eventId}@${meeting.start}`}>
            <span className="meeting-time">{formatClock(meeting.start)}</span>
            <span className="meeting-type-title" title={meeting.title}>
              <span className="meeting-type-dot" style={{ background: colourFor(meetingCategory(meeting.type)) }} />
              {meeting.title}
            </span>
            <span className="muted meeting-type-ms">{meeting.attended ? formatDuration(meeting.ms) : "not in a call"}</span>
            <select
              value={meeting.type ?? ""}
              aria-label={`Type of ${meeting.title}`}
              onChange={(event) => void pick(meeting, event.target.value as MeetingType)}
            >
              {meeting.type === null && (
                <option value="" disabled>
                  Not sorted yet
                </option>
              )}
              {(Object.keys(MEETING_TYPE_LABELS) as MeetingType[]).map((type) => (
                <option key={type} value={type}>
                  {MEETING_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
            <span className="muted meeting-type-source">{SOURCE_TEXT[meeting.typeSource ?? "none"]}</span>
          </li>
        ))}
      </ul>
      {message && <p className="message">{message}</p>}
    </div>
  );
}

/** Who set each type, in plain words. */
const SOURCE_TEXT = { haiku: "Haiku's guess", you: "your pick", none: "" } as const;

/**
 * Writes a time of day the short way.
 * @param ms The moment.
 * @returns e.g. "9:30 AM".
 */
function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
