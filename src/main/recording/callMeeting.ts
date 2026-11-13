import type { MeetingProvider } from "../../shared/ipc";
import type { StoredSegment } from "../activity/ActivityStore";
import type { CalendarEvent } from "../calendar/meetingLinks";
import type { StoredRecording } from "./RecordingStore";

/** A stretch of a call spent in one meeting. */
export interface CallSection {
  meeting: CalendarEvent;
  start: number;
  end: number;
}

/** A front window from the activity log, read for which meeting you were in. */
export type CallWindow = Pick<StoredSegment, "startedAt" | "app" | "title" | "url">;

/** How long before a call starts its windows still count: the meeting window usually opens just before the microphone. */
export const WINDOWS_BEFORE_MS = 10 * 60_000;

/** A meeting needs this long in a call to get its own section; a shorter stretch joins its neighbour. */
export const SHORTEST_SECTION_MS = 3 * 60_000;

/** A gap this short before a meeting is you joining it early rather than the meeting before running over. */
export const EARLY_JOIN_MS = 5 * 60_000;

/** What a front window says about the meeting you're in. */
interface WindowCue {
  at: number;
  provider: MeetingProvider;
  /** The meeting's name as the window shows it ("Meet - Dept. OB: Innovation"), if it does. */
  name: string | null;
  /** A Google Meet code ("twr-tend-hrq") from the window's address, if it has one. */
  meetCode: string | null;
}

/** Words too common in meeting titles to tell two meetings apart. */
const COMMON_WORDS = new Set(["the", "and", "with", "for", "meeting", "call", "sync", "session", "microsoft", "teams", "zoom", "google"]);

/** A Google Meet code in an address. */
const MEET_CODE = /meet\.google\.com\/(?:meet\/)?([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})/i;

/**
 * Splits a call into the meetings it ran through, in order. At each moment the meeting is picked from those on
 * the calendar then: one the call window names (a Meet tab's title or code, a Teams window's title) first, then
 * one on the app in front last (Zoom, Meet or Teams), then one you accepted over one you said maybe to (a maybe
 * that overlaps an accepted meeting is usually the one you join after it), then the shorter one. Time with no
 * meeting on joins a neighbour (see fillGaps), and a stretch under three minutes joins the one before.
 * @param recording The call.
 * @param meetings The meetings around it.
 * @param windows Front windows from the activity log; only those from ten minutes before the call to its end are read.
 * @param now The current time, the end of a call still going.
 * @returns The sections, or none when no meeting overlapped.
 */
export function callSections(recording: StoredRecording, meetings: CalendarEvent[], windows: CallWindow[], now: number): CallSection[] {
  const end = recording.end ?? now;
  const overlapping = meetings.filter(
    (meeting) => meeting.response !== "declined" && meeting.start < end && recording.start < meeting.end,
  );
  // A real meeting (other people, or a call link) beats a block you put in for yourself ("Pay credit card!").
  const real = overlapping.filter(isRealMeeting);
  const candidates = real.length > 0 ? real : overlapping;
  if (candidates.length === 0 || end <= recording.start) {
    return [];
  }
  const cues = windows
    .map(readCue)
    .filter((cue): cue is WindowCue => cue !== null && cue.at >= recording.start - WINDOWS_BEFORE_MS && cue.at <= end)
    .sort((a, b) => a.at - b.at);
  const cuts = [...new Set([recording.start, end, ...candidates.flatMap((meeting) => [meeting.start, meeting.end]), ...cues.map((cue) => cue.at)])]
    .filter((at) => at >= recording.start && at <= end)
    .sort((a, b) => a - b);
  const pieces = cuts.slice(1).map((pieceEnd, i) => {
    const start = cuts[i];
    const cue = cues.filter((each) => each.at <= start).at(-1) ?? null;
    return { meeting: meetingAt(candidates, start, cue), start, end: pieceEnd };
  });
  return absorbShort(merge(fillGaps(pieces)));
}

/**
 * Names a call: the title of each meeting it ran through, in order.
 * @param sections The call's sections.
 * @returns The titles joined, or null when it matched no meeting.
 */
export function callTitle(sections: CallSection[]): string | null {
  const titles = [...new Set(sections.map((section) => section.meeting.title))];
  return titles.length > 0 ? titles.join(" · ") : null;
}

/**
 * Finds the meeting a call overlapped most, ignoring which windows were in front. Names the call's audio file.
 * @param recording The call.
 * @param meetings The day's meetings.
 * @param now The current time, the end of a call still going.
 * @returns The meeting, or null when none overlapped.
 */
export function bestMeeting(recording: StoredRecording, meetings: CalendarEvent[], now: number): CalendarEvent | null {
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
 * Reads a front window for the meeting it shows: a Google Meet tab, a Teams window, or a Zoom meeting window.
 * Zoom's windows never name the meeting, and its main window ("Zoom Workplace") isn't one.
 * @param window The window.
 * @returns What it says, or null for a window that isn't a meeting's.
 */
function readCue(window: CallWindow): WindowCue | null {
  const title = window.title ?? "";
  const url = window.url ?? "";
  const at = window.startedAt;
  if (url.includes("meet.google.com") || title.startsWith("Meet - ") || title.includes("meet.google.com")) {
    const name = title.startsWith("Meet - ") ? title.slice("Meet - ".length).split(" - ")[0] : null;
    return { at, provider: "meet", name, meetCode: MEET_CODE.exec(url)?.[1]?.toLowerCase() ?? null };
  }
  if (window.app === "Microsoft Teams" || /teams\.(microsoft|live)\.com/.test(url)) {
    return { at, provider: "teams", name: window.app === "Microsoft Teams" ? title.split(" | ")[0] : null, meetCode: null };
  }
  if ((window.app === "Zoom" || window.app === "zoom.us") && title !== "Zoom Workplace") {
    return { at, provider: "zoom", name: null, meetCode: null };
  }
  return null;
}

/**
 * Picks the meeting you were most likely in at a moment, from those on the calendar then.
 * @param meetings The candidates.
 * @param at The moment.
 * @param cue The last meeting window in front at or before it.
 * @returns The meeting, or null when none is on.
 */
function meetingAt(meetings: CalendarEvent[], at: number, cue: WindowCue | null): CalendarEvent | null {
  const on = meetings.filter((meeting) => meeting.start <= at && at < meeting.end);
  const score = (meeting: CalendarEvent) =>
    (cue && namesMeeting(cue, meeting) ? 4 : 0) + (cue && cue.provider === meeting.provider ? 2 : 0) + (meeting.response === "accepted" ? 1 : 0);
  const ranked = on.sort((a, b) => score(b) - score(a) || a.end - a.start - (b.end - b.start) || a.start - b.start);
  return ranked[0] ?? null;
}

/**
 * Whether a window names a meeting: the same Meet code, or the window's name sharing the title's telling words.
 * Teams shows "QbD WS4 Kickoff" for "QbD WS4 - Working Session", so two shared words are enough.
 * @param cue The window.
 * @param meeting The meeting.
 * @returns True when they match.
 */
function namesMeeting(cue: WindowCue, meeting: CalendarEvent): boolean {
  if (cue.meetCode && meeting.joinUrl && MEET_CODE.exec(meeting.joinUrl)?.[1]?.toLowerCase() === cue.meetCode) {
    return true;
  }
  if (!cue.name) {
    return false;
  }
  const titleWords = tellingWords(meeting.title);
  const nameWords = tellingWords(cue.name);
  const shared = [...titleWords].filter((word) => nameWords.has(word)).length;
  return titleWords.size > 0 && shared >= Math.min(2, titleWords.size);
}

/**
 * The words in a title that tell it apart: lowercase letters and digits, three or more long, not common ones.
 * @param text The title.
 * @returns The words.
 */
function tellingWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((word) => word.length >= 3 && !COMMON_WORDS.has(word)));
}

/**
 * Gives time with no meeting on to a neighbour: up to five minutes before a meeting is joining it early; a longer
 * gap is the meeting before running over (or, before the first meeting, joining that one early).
 * @param pieces The call's pieces, in order.
 * @returns The pieces, each with a meeting.
 */
function fillGaps(pieces: { meeting: CalendarEvent | null; start: number; end: number }[]): CallSection[] {
  const filled: CallSection[] = [];
  let previous: CalendarEvent | null = null;
  pieces.forEach((piece, i) => {
    // The whole gap counts, not just this piece of it: a window switch can cut a gap into slivers.
    const nextAt = pieces.findIndex((later, j) => j > i && later.meeting !== null);
    const next = nextAt === -1 ? null : pieces[nextAt].meeting;
    const gapStart = pieces.slice(0, i + 1).findLast((earlier) => earlier.meeting !== null)?.end ?? pieces[0].start;
    const early = next !== null && pieces[nextAt].start - gapStart <= EARLY_JOIN_MS;
    const meeting = piece.meeting ?? (early ? next : (previous ?? next));
    if (meeting) {
      filled.push({ meeting, start: piece.start, end: piece.end });
    }
    previous = piece.meeting ?? previous;
  });
  return filled;
}

/**
 * Joins neighbouring sections of the same meeting.
 * @param sections The sections, in order.
 * @returns Fewer, longer sections.
 */
function merge(sections: CallSection[]): CallSection[] {
  const merged: CallSection[] = [];
  for (const section of sections) {
    const last = merged.at(-1);
    if (last && last.meeting === section.meeting) {
      last.end = section.end;
    } else {
      merged.push({ ...section });
    }
  }
  return merged;
}

/**
 * Folds a section under three minutes into the one before it (or after it, when it comes first), so a glance at
 * another window doesn't start a new meeting.
 * @param sections The sections, in order.
 * @returns The sections without the short ones.
 */
function absorbShort(sections: CallSection[]): CallSection[] {
  let kept = sections;
  let short = kept.findIndex((section) => section.end - section.start < SHORTEST_SECTION_MS);
  while (short !== -1 && kept.length > 1) {
    const neighbour = short > 0 ? short - 1 : 1;
    const joined = { meeting: kept[neighbour].meeting, start: Math.min(kept[short].start, kept[neighbour].start), end: Math.max(kept[short].end, kept[neighbour].end) };
    kept = merge([...kept.slice(0, Math.min(short, neighbour)), joined, ...kept.slice(Math.max(short, neighbour) + 1)]);
    short = kept.findIndex((section) => section.end - section.start < SHORTEST_SECTION_MS);
  }
  return kept;
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
