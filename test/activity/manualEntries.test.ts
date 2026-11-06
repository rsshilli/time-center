import { assertNewManualEntry, fillAwayGaps } from "../../src/main/activity/manualEntries";
import type { ManualEntry, TimelineItem } from "../../src/shared/ipc";

const MIN = 60_000;

/**
 * A stretch of the timeline with defaults for the fields a test doesn't care about.
 * @param fields The fields that matter.
 * @returns The stretch.
 */
const item = (fields: Partial<TimelineItem>): TimelineItem => ({
  start: 0,
  end: 0,
  kind: "idle",
  category: "Away",
  app: null,
  title: null,
  url: null,
  domain: null,
  project: null,
  ...fields,
});

/**
 * A marked stretch.
 * @param id Its id.
 * @param start Start, in minutes.
 * @param end End, in minutes.
 * @param category Its category.
 * @returns The entry.
 */
const entry = (id: number, start: number, end: number, category = "Driving"): ManualEntry => ({
  id,
  start: start * MIN,
  end: end * MIN,
  category,
  eventId: null,
});

/**
 * Shows a timeline as [category, start minute, end minute] rows, for short expectations.
 * @param timeline The timeline.
 * @returns The rows.
 */
const rows = (timeline: TimelineItem[]) => timeline.map((piece) => [piece.category, piece.start / MIN, piece.end / MIN]);

describe("fillAwayGaps", () => {
  it("should fill only the Away time inside the marked stretch and leave the rest of the gap Away", () => {
    const timeline = [
      item({ start: 0, end: 10 * MIN, kind: "active", category: "Coding" }),
      item({ start: 10 * MIN, end: 60 * MIN }),
    ];
    expect(rows(fillAwayGaps(timeline, [entry(1, 5, 40)]))).toEqual([
      ["Coding", 0, 10],
      ["Driving", 10, 40],
      ["Away", 40, 60],
    ]);
  });

  it("should give overlapping time to the older entry", () => {
    const timeline = [item({ start: 0, end: 60 * MIN })];
    expect(rows(fillAwayGaps(timeline, [entry(1, 10, 30), entry(2, 20, 50, "Meetings · Other")]))).toEqual([
      ["Away", 0, 10],
      ["Driving", 10, 30],
      ["Meetings · Other", 30, 50],
      ["Away", 50, 60],
    ]);
  });

  it("should mark filled time as active, and as a call only when it is a meeting", () => {
    const [filled] = fillAwayGaps([item({ start: 0, end: 10 * MIN })], [{ ...entry(7, 0, 10), eventId: "ws4" }]);
    expect(filled).toEqual(expect.objectContaining({ kind: "active", onCall: true, manual: { id: 7, eventId: "ws4" } }));
  });

  it("should fill time the Mac recorded nothing (asleep), but only where an entry covers it", () => {
    const timeline = [
      item({ start: 0, end: 10 * MIN, kind: "active", category: "Coding" }),
      item({ start: 100 * MIN, end: 110 * MIN, kind: "active", category: "Coding" }),
    ];
    expect(rows(fillAwayGaps(timeline, [entry(1, 5, 40), entry(2, 30, 50, "Meetings · Other")]))).toEqual([
      ["Coding", 0, 10],
      ["Driving", 10, 40],
      ["Meetings · Other", 40, 50],
      ["Coding", 100, 110],
    ]);
  });

  it("should leave untracked time alone", () => {
    const timeline = [item({ start: 0, end: 10 * MIN, kind: "untracked", category: "Untracked" })];
    expect(rows(fillAwayGaps(timeline, [entry(1, 0, 10)]))).toEqual([["Untracked", 0, 10]]);
  });
});

describe("assertNewManualEntry", () => {
  it("should accept a stretch with a trimmed category and an optional meeting", () => {
    expect(assertNewManualEntry({ start: 0, end: MIN, category: "  On the phone ", eventId: null })).toEqual({
      start: 0,
      end: MIN,
      category: "On the phone",
      eventId: null,
    });
    expect(assertNewManualEntry({ start: 0, end: MIN, category: "Driving" }).eventId).toBeNull();
    expect(assertNewManualEntry({ start: 0, end: MIN, category: "Driving", eventId: "" }).eventId).toBeNull();
  });

  it("should reject backwards or day-long-plus stretches, blank categories and odd meeting ids", () => {
    expect(() => assertNewManualEntry({ start: MIN, end: 0, category: "x" })).toThrow(/after it starts/);
    expect(() => assertNewManualEntry({ start: 0, end: 25 * 60 * MIN, category: "x" })).toThrow(/a day long/);
    expect(() => assertNewManualEntry({ start: 0, end: MIN, category: "  " })).toThrow(/category/);
    expect(() => assertNewManualEntry({ start: 0, end: MIN, category: "x", eventId: 5 })).toThrow(/meeting id/);
    expect(() => assertNewManualEntry(null)).toThrow(/start and an end/);
  });
});
