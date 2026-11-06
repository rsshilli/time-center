import { meetingCategory, type DayMeeting, type TimelineItem } from "../shared/ipc";
import { MINUTE } from "./timelineStep";
import type { TimeRange } from "./timelineZoom";

/** The categories offered for a marked stretch that isn't a calendar meeting; you can also type your own. */
export const ENTRY_CATEGORIES: readonly string[] = [meetingCategory("other"), "Driving"];

/** A calendar block whose title says you were on the road, such as "Drive to the airport". */
const DRIVING_TITLE = /\bdriv(e|es|ing)\b/i;

/**
 * Turns the two ends of a drag into a stretch: earliest first, rounded to whole minutes, kept on the bar.
 * @param a Where the drag started.
 * @param b Where it ended.
 * @param bounds The part of the day the bar shows.
 * @returns The stretch; it may be empty when the drag was shorter than a minute.
 */
export function snapRange(a: number, b: number, bounds: TimeRange): TimeRange {
  /**
   * Rounds a moment to the minute and keeps it on the bar.
   * @param ms The moment.
   * @returns The rounded moment.
   */
  const clamp = (ms: number) => Math.min(Math.max(Math.round(ms / MINUTE) * MINUTE, bounds.from), bounds.to);
  return { from: clamp(Math.min(a, b)), to: clamp(Math.max(a, b)) };
}

/**
 * Adds up the Away time inside a stretch, the only time a marked stretch fills: time the Mac saw no one,
 * or recorded nothing at all (asleep). Time already filled by another entry doesn't count.
 * @param timeline The day's stretches.
 * @param range The stretch.
 * @returns Milliseconds of Away time.
 */
export function awayMsIn(timeline: readonly TimelineItem[], range: TimeRange): number {
  const atTheMac = timeline
    .filter((item) => item.kind !== "idle")
    .reduce((sum, item) => sum + Math.max(0, Math.min(item.end, range.to) - Math.max(item.start, range.from)), 0);
  return range.to - range.from - atTheMac;
}

/**
 * Picks what the panel starts with for a new stretch: the meeting covering most of it, or Driving when
 * that block's title says you were driving (a "Drive to …" block is time on the road, not a meeting).
 * @param meetings The day's calendar blocks.
 * @param range The stretch.
 * @returns The meeting to link, or null, and the category for no meeting.
 */
export function guessEntry(meetings: readonly DayMeeting[], range: TimeRange): { eventId: string | null; category: string } {
  const best = suggestMeetings(meetings, range)[0];
  if (best && DRIVING_TITLE.test(best.title)) {
    return { eventId: null, category: "Driving" };
  }
  return { eventId: best?.eventId ?? null, category: ENTRY_CATEGORIES[0] };
}

/**
 * Lists the calendar meetings you were probably on during a stretch: the ones overlapping it, the one
 * covering most of it first.
 * @param meetings The day's meetings.
 * @param range The stretch.
 * @returns The overlapping meetings, best guess first.
 */
export function suggestMeetings(meetings: readonly DayMeeting[], range: TimeRange): DayMeeting[] {
  /**
   * Measures how much of the stretch a meeting covers.
   * @param meeting The meeting.
   * @returns The shared time, negative when they don't meet.
   */
  const overlap = (meeting: DayMeeting) => Math.min(meeting.end, range.to) - Math.max(meeting.start, range.from);
  return meetings.filter((meeting) => overlap(meeting) > 0).sort((a, b) => overlap(b) - overlap(a) || a.start - b.start);
}
