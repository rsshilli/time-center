import { MEETINGS_CATEGORY, meetingCategory, type DayMeeting, type TimelineItem } from "../../shared/ipc";
import type { TypedEvent } from "../calendar/CalendarStore";

/** The parts of a calendar meeting the split reads. */
export type MeetingForDay = Pick<
  TypedEvent,
  "eventId" | "title" | "start" | "end" | "response" | "type" | "typeSource" | "joinUrl" | "attendees"
>;

/** Call time a meeting needs of its own to count as attended, so a call running into it doesn't. */
export const MIN_CALL_MS = 5 * 60_000;

/** A stretch of time, in milliseconds since 1970. */
interface Span {
  start: number;
  end: number;
}

/**
 * Splits the day's meeting time by type. A calendar meeting counts as attended when you were on a call
 * for at least five minutes of it (or half of it, if it's shorter) that no earlier meeting already
 * claimed, or when it's an accepted in-person meeting (guests, no call link). Then ALL active time during
 * it, whatever app was in front, goes to "Meetings · <its type>". Call time outside any attended meeting
 * goes to "Meetings · Other" — or stays plain "Meetings" on a day with no calendar meetings at all.
 * Stretches are cut at meeting starts and ends so each piece belongs to one meeting at most.
 * @param timeline The day's stretches, categorized by the rules.
 * @param meetings The day's calendar meetings with their types.
 * @returns The re-categorized timeline, and the meetings worth listing with the time each got.
 */
export function splitMeetingTime(
  timeline: readonly TimelineItem[],
  meetings: readonly MeetingForDay[],
): { timeline: TimelineItem[]; meetings: DayMeeting[] } {
  const invited = meetings.filter((meeting) => meeting.response !== "declined");
  const ownCalls = claimCallTime(timeline.filter(isCallTime), invited);
  const attended = invited.filter((meeting) => ownCalls.has(meeting) || isInPerson(meeting));
  const msByEvent = new Map<string, number>();
  const pieces = timeline.flatMap((item) => (item.kind === "active" ? cutAtMeetings(item, attended) : [item]));
  const sorted = pieces.map((piece) => {
    if (piece.kind !== "active") {
      return piece;
    }
    const meeting = meetingAt(piece, attended, ownCalls);
    if (meeting) {
      msByEvent.set(meeting.eventId, (msByEvent.get(meeting.eventId) ?? 0) + (piece.end - piece.start));
      return { ...piece, category: meetingCategory(meeting.type) };
    }
    if (piece.category === MEETINGS_CATEGORY && invited.length > 0) {
      return { ...piece, category: meetingCategory("other") };
    }
    return piece;
  });
  return {
    timeline: sorted,
    // Blocks with nobody else invited ("Drive to …") are only listed if you were on a call in them.
    meetings: invited
      .filter((meeting) => meeting.attendees.length > 0 || attended.includes(meeting))
      .map((meeting) => ({
        eventId: meeting.eventId,
        title: meeting.title,
        start: meeting.start,
        end: meeting.end,
        type: meeting.type,
        typeSource: meeting.typeSource,
        attended: attended.includes(meeting),
        ms: msByEvent.get(meeting.eventId) ?? 0,
      })),
  };
}

/**
 * Says whether a stretch was spent on a call: the microphone was in use, or the rules put it in Meetings.
 * @param item The stretch.
 * @returns True for call time.
 */
function isCallTime(item: TimelineItem): boolean {
  return item.kind === "active" && (item.onCall === true || item.category === MEETINGS_CATEGORY);
}

/**
 * Hands each minute of call time to one meeting: meetings take the call time inside them that no meeting
 * before them took, shortest first (a 1:1 inside an all-day block is the more specific answer), then
 * earliest first. A meeting keeps its share only if it reaches MIN_CALL_MS (or half its length), so a
 * call that overruns into the next slot, or a double-booked slot you skipped, isn't counted.
 * @param calls The day's call stretches.
 * @param meetings The meetings you didn't decline.
 * @returns The call time each attended-by-call meeting owns.
 */
function claimCallTime(calls: readonly Span[], meetings: readonly MeetingForDay[]): Map<MeetingForDay, Span[]> {
  const owned = new Map<MeetingForDay, Span[]>();
  let claimed: Span[] = [];
  const order = [...meetings].sort((a, b) => a.end - a.start - (b.end - b.start) || a.start - b.start);
  for (const meeting of order) {
    const inside = calls
      .map((call) => ({ start: Math.max(call.start, meeting.start), end: Math.min(call.end, meeting.end) }))
      .filter((span) => span.end > span.start);
    const own = subtract(inside, claimed);
    const ms = own.reduce((sum, span) => sum + (span.end - span.start), 0);
    if (ms > 0 && ms >= Math.min(MIN_CALL_MS, (meeting.end - meeting.start) / 2)) {
      owned.set(meeting, own);
      claimed = [...claimed, ...own];
    }
  }
  return owned;
}

/**
 * Says whether a meeting looks in-person: accepted, with other guests, and no call link.
 * @param meeting The meeting.
 * @returns True when it does.
 */
function isInPerson(meeting: MeetingForDay): boolean {
  return meeting.response === "accepted" && meeting.joinUrl === null && meeting.attendees.length > 0;
}

/**
 * Cuts a stretch wherever a meeting starts or ends inside it.
 * @param item The stretch.
 * @param meetings The attended meetings.
 * @returns The pieces, in order.
 */
function cutAtMeetings(item: TimelineItem, meetings: readonly MeetingForDay[]): TimelineItem[] {
  const cuts = [...new Set(meetings.flatMap((meeting) => [meeting.start, meeting.end]))]
    .filter((at) => at > item.start && at < item.end)
    .sort((a, b) => a - b);
  const bounds = [item.start, ...cuts, item.end];
  return bounds.slice(1).map((end, index) => ({ ...item, start: bounds[index], end }));
}

/**
 * Picks the meeting a piece of time belongs to. Of the attended meetings covering it, one whose own call
 * time includes the piece wins; otherwise the one that started last, since you most likely moved on to it.
 * @param piece The piece, which no meeting starts or ends inside.
 * @param meetings The attended meetings.
 * @param ownCalls The call time each meeting owns.
 * @returns The meeting, or null.
 */
function meetingAt(
  piece: TimelineItem,
  meetings: readonly MeetingForDay[],
  ownCalls: ReadonlyMap<MeetingForDay, Span[]>,
): MeetingForDay | null {
  const covering = meetings.filter((meeting) => meeting.start <= piece.start && meeting.end >= piece.end);
  const onItsCall = covering.find((meeting) =>
    (ownCalls.get(meeting) ?? []).some((span) => span.start < piece.end && piece.start < span.end),
  );
  if (onItsCall) {
    return onItsCall;
  }
  return covering.reduce<MeetingForDay | null>((latest, meeting) => (!latest || meeting.start > latest.start ? meeting : latest), null);
}

/**
 * Removes some spans of time from others.
 * @param spans What to keep.
 * @param removed What to take out of it.
 * @returns What's left, as non-empty spans.
 */
function subtract(spans: readonly Span[], removed: readonly Span[]): Span[] {
  let left = [...spans];
  for (const cut of removed) {
    left = left.flatMap((span) => {
      if (cut.end <= span.start || cut.start >= span.end) {
        return [span];
      }
      return [
        { start: span.start, end: cut.start },
        { start: cut.end, end: span.end },
      ].filter((part) => part.end > part.start);
    });
  }
  return left;
}
