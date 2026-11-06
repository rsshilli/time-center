import { MAX_ENTRY_CATEGORY_LENGTH as MAX_CATEGORY_LENGTH, type ManualEntry, type NewManualEntry, type TimelineItem } from "../../shared/ipc";
import { AWAY } from "./classify";

/** Longer than any Google Calendar event id, so a longer one is not a real meeting. */
const MAX_EVENT_ID_LENGTH = 1024;

/** The longest stretch you can mark at once: a full day. */
const MAX_ENTRY_MS = 24 * 3_600_000;

/**
 * Checks a marked stretch sent by the renderer. A blank meeting id means no meeting.
 * @param value What the renderer sent.
 * @returns The entry, with its category trimmed.
 * @throws When a time, the category or the meeting id is missing or malformed.
 */
export function assertNewManualEntry(value: unknown): NewManualEntry {
  const entry = value as Partial<NewManualEntry> | null;
  const start = entry?.start;
  const end = entry?.end;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("A marked stretch needs a start and an end.");
  }
  if (end <= start || end - start > MAX_ENTRY_MS) {
    throw new Error("A marked stretch must end after it starts, and be at most a day long.");
  }
  const category = typeof entry?.category === "string" ? entry.category.trim() : "";
  if (category === "" || category.length > MAX_CATEGORY_LENGTH) {
    throw new Error(`Give the stretch a category of 1 to ${MAX_CATEGORY_LENGTH} characters.`);
  }
  const eventId = entry?.eventId || null;
  if (eventId !== null && (typeof eventId !== "string" || eventId.length > MAX_EVENT_ID_LENGTH)) {
    throw new Error("The meeting id must be text.");
  }
  return { start, end, category, eventId };
}

/**
 * Fills the Away parts of the timeline with the stretches you marked yourself. Away means the Mac saw no
 * keyboard or mouse, or recorded nothing at all (asleep, or the lid shut). Time recorded at the Mac stays
 * as it is (the user's pick), so an entry never replaces it. Where two entries overlap, the older one keeps
 * the time.
 * @param timeline The day's stretches, in order.
 * @param entries The marked stretches, clipped to the day, oldest first.
 * @returns The timeline with the filled pieces in place of the Away time they cover.
 */
export function fillAwayGaps(timeline: readonly TimelineItem[], entries: readonly ManualEntry[]): TimelineItem[] {
  const withHoles = [...timeline, ...unrecordedSpans(timeline, entries).map(awayItem)].sort((a, b) => a.start - b.start);
  return withHoles.flatMap((item) => (item.kind === "idle" ? fillOneGap(item, entries) : [item]));
}

/**
 * Finds the time inside the entries that has no recording at all. Only time an entry covers is returned,
 * so the rest of a night's sleep doesn't turn into Away time on the dashboard.
 * @param timeline The day's stretches.
 * @param entries The marked stretches.
 * @returns The unrecorded spans, not overlapping one another.
 */
function unrecordedSpans(timeline: readonly TimelineItem[], entries: readonly ManualEntry[]): { start: number; end: number }[] {
  const covered = mergeSpans(entries);
  return timeline.reduce(
    (left, item) =>
      left.flatMap((span) =>
        [
          { start: span.start, end: Math.min(span.end, item.start) },
          { start: Math.max(span.start, item.end), end: span.end },
        ].filter((part) => part.end > part.start),
      ),
    covered,
  );
}

/**
 * Makes an Away stretch for time with no recording.
 * @param span The time.
 * @returns The stretch.
 */
function awayItem(span: { start: number; end: number }): TimelineItem {
  return {
    ...span,
    kind: "idle",
    category: AWAY,
    app: null,
    title: null,
    url: null,
    domain: null,
    project: null,
  };
}

/**
 * Fills one stretch of Away time from the entries, walking through it in time order.
 * @param item The Away stretch.
 * @param entries The marked stretches, oldest first.
 * @returns The pieces: filled ones and whatever is still Away.
 */
function fillOneGap(item: TimelineItem, entries: readonly ManualEntry[]): TimelineItem[] {
  const filled: { start: number; end: number; entry: ManualEntry }[] = [];
  for (const entry of entries) {
    let free = [{ start: Math.max(entry.start, item.start), end: Math.min(entry.end, item.end) }];
    for (const taken of filled) {
      free = free.flatMap((span) =>
        [
          { start: span.start, end: Math.min(span.end, taken.start) },
          { start: Math.max(span.start, taken.end), end: span.end },
        ].filter((part) => part.end > part.start),
      );
    }
    filled.push(...free.filter((span) => span.end > span.start).map((span) => ({ ...span, entry })));
  }
  filled.sort((a, b) => a.start - b.start);
  const pieces: TimelineItem[] = [];
  let at = item.start;
  for (const fill of filled) {
    if (fill.start > at) {
      pieces.push({ ...item, start: at, end: fill.start });
    }
    pieces.push({
      start: fill.start,
      end: fill.end,
      kind: "active",
      category: fill.entry.category,
      app: null,
      title: fill.entry.category,
      url: null,
      domain: null,
      project: null,
      onCall: fill.entry.eventId !== null,
      manual: { id: fill.entry.id, eventId: fill.entry.eventId },
    });
    at = fill.end;
  }
  if (at < item.end) {
    pieces.push({ ...item, start: at, end: item.end });
  }
  return pieces;
}

/**
 * Joins overlapping or touching spans.
 * @param spans The spans, in any order.
 * @returns The joined spans, earliest first.
 */
function mergeSpans(spans: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ start: span.start, end: span.end });
    }
  }
  return merged;
}
