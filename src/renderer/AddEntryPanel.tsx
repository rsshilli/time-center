import { useEffect, useRef, useState } from "react";
import { MAX_ENTRY_CATEGORY_LENGTH, meetingCategory, type DayReport } from "../shared/ipc";
import { formatClock, formatDuration } from "./format";
import { ENTRY_CATEGORIES, awayMsIn, guessEntry, suggestMeetings } from "./manualEntry";
import type { TimeRange } from "./timelineZoom";

/** The drop-down value for "this wasn't a calendar meeting". */
const NO_MEETING = "";

/** The radio value for typing your own category. */
const OWN_CATEGORY = "own";

/**
 * Marks a stretch you dragged out on the timeline, such as a call taken on your phone while away from the
 * Mac. It suggests the calendar meeting you were probably on; with no meeting, you pick Meetings · Other,
 * Driving, or type a category. Only the Away time inside the stretch is filled.
 * @param props.range The stretch.
 * @param props.report The day, for its Away time and meetings.
 * @param props.onClose Called to hide the panel.
 * @param props.onSaved Called after the entry is saved, to re-read the day.
 */
export function AddEntryPanel({
  range,
  report,
  onClose,
  onSaved,
}: {
  range: TimeRange;
  report: DayReport;
  onClose: () => void;
  onSaved: () => void;
}) {
  const suggestions = suggestMeetings(report.allMeetings, range);
  const [eventId, setEventId] = useState(() => guessEntry(report.allMeetings, range).eventId ?? NO_MEETING);
  const [choice, setChoice] = useState(() => guessEntry(report.allMeetings, range).category);
  const [own, setOwn] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const awayMs = awayMsIn(report.timeline, range);
  const category = choice === OWN_CATEGORY ? own.trim() : choice;
  const ready = awayMs > 0 && (eventId !== NO_MEETING || category !== "") && !saving;

  useEffect(() => {
    // A new drag picks a new best guess and clears the last stretch's error.
    const guess = guessEntry(report.allMeetings, range);
    setEventId(guess.eventId ?? NO_MEETING);
    setChoice(guess.category);
    setError(null);
    panel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [range.from, range.to]);

  /** Saves the entry. A meeting's own type decides its category; "Meetings · Other" is kept as a fallback. */
  const save = async () => {
    setSaving(true);
    try {
      await window.timeCenter.addManualEntry({
        start: range.from,
        end: range.to,
        category: eventId === NO_MEETING ? category : meetingCategory("other"),
        eventId: eventId === NO_MEETING ? null : eventId,
      });
      onSaved();
      onClose();
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : String(caught);
      setError(`Couldn't save it: ${text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
      setSaving(false);
    }
  };

  return (
    <div className="card add-entry" ref={panel}>
      <header className="uncategorized-header">
        <h2>
          What were you doing {formatClock(range.from)} – {formatClock(range.to)}?
        </h2>
        <button className="link" onClick={onClose}>
          Cancel
        </button>
      </header>
      <p className="muted">
        {awayMs > 0
          ? `Fills the ${formatDuration(awayMs)} you were away from the Mac in this stretch. Time recorded at the Mac stays as it is.`
          : "You were at the Mac for all of this stretch, so there's no Away time to fill. Drag over a grey part of the timeline."}
      </p>
      <label className="add-entry-row">
        <span>Meeting</span>
        <select value={eventId} onChange={(event) => setEventId(event.target.value)}>
          {suggestions.map((meeting) => (
            <option key={meeting.eventId} value={meeting.eventId}>
              {meeting.title} ({formatClock(meeting.start)} – {formatClock(meeting.end)})
            </option>
          ))}
          <option value={NO_MEETING}>No meeting</option>
        </select>
      </label>
      {eventId === NO_MEETING && (
        <fieldset className="add-entry-row">
          <span>Count it as</span>
          {ENTRY_CATEGORIES.map((name) => (
            <label key={name}>
              <input type="radio" name="entry-category" checked={choice === name} onChange={() => setChoice(name)} /> {name}
            </label>
          ))}
          <label>
            <input type="radio" name="entry-category" checked={choice === OWN_CATEGORY} onChange={() => setChoice(OWN_CATEGORY)} />{" "}
            <input
              value={own}
              placeholder="Something else"
              maxLength={MAX_ENTRY_CATEGORY_LENGTH}
              onFocus={() => setChoice(OWN_CATEGORY)}
              onChange={(event) => setOwn(event.target.value)}
              aria-label="Your own category"
            />
          </label>
        </fieldset>
      )}
      {error && <p className="error">{error}</p>}
      <div className="add-entry-actions">
        <button onClick={() => void save()} disabled={!ready}>
          {saving ? "Saving…" : "Add"}
        </button>
      </div>
    </div>
  );
}
