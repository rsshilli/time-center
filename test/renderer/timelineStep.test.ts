import { describe, expect, it } from "vitest";
import type { SegmentKind, TimelineItem } from "../../src/shared/ipc";
import { MINUTE, SHIFT_STEP, stepMoment, stepToChange } from "../../src/renderer/timelineStep";

/** 10:00 on some day. */
const TEN = Date.UTC(2026, 10, 5, 10, 0, 0);

/**
 * Builds one stretch of the timeline.
 * @param startMinute Minutes after 10:00 it starts.
 * @param endMinute Minutes after 10:00 it ends.
 * @param app The app in front, or null.
 * @param kind What kind of time it was.
 * @param title The window title.
 * @returns The stretch.
 */
function item(startMinute: number, endMinute: number, app: string | null, kind: SegmentKind = "active", title = ""): TimelineItem {
  return {
    start: TEN + startMinute * MINUTE,
    end: TEN + endMinute * MINUTE,
    kind,
    category: "Other",
    app,
    title,
    url: null,
    domain: null,
    project: null,
  };
}

describe("stepToChange", () => {
  const timeline = [
    item(0, 5, "Chrome", "active", "Mail"),
    item(5, 12, "Chrome", "active", "Calendar"),
    item(12, 20, "WebStorm"),
    item(20, 30, null, "idle"),
    item(40, 45, "WebStorm"),
  ];

  it("should move to the next app change, skipping title changes in the same app", () => {
    expect(stepToChange(timeline, TEN + MINUTE, 1)).toBe(TEN + 12 * MINUTE);
  });

  it("should treat going idle and coming back after a gap as changes", () => {
    expect(stepToChange(timeline, TEN + 12 * MINUTE, 1)).toBe(TEN + 20 * MINUTE);
    expect(stepToChange(timeline, TEN + 20 * MINUTE, 1)).toBe(TEN + 40 * MINUTE);
  });

  it("should move back to where the current stretch started, then to the change before it", () => {
    expect(stepToChange(timeline, TEN + 15 * MINUTE, -1)).toBe(TEN + 12 * MINUTE);
    expect(stepToChange(timeline, TEN + 12 * MINUTE, -1)).toBe(TEN);
  });

  it("should stay put when there is no change further in that direction", () => {
    expect(stepToChange(timeline, TEN + 42 * MINUTE, 1)).toBe(TEN + 42 * MINUTE);
    expect(stepToChange(timeline, TEN, -1)).toBe(TEN);
    expect(stepToChange([], TEN, 1)).toBe(TEN);
  });
});

describe("stepMoment", () => {
  const from = TEN - 60 * MINUTE;
  const to = TEN + 60 * MINUTE;

  it("should move one step later on Right and earlier on Left from a minute mark", () => {
    expect(stepMoment(TEN, 1, MINUTE, from, to)).toBe(TEN + MINUTE);
    expect(stepMoment(TEN, -1, SHIFT_STEP, from, to)).toBe(TEN - 10 * MINUTE);
  });

  it("should land on whole minutes when starting between marks", () => {
    const clicked = TEN + 30_000;
    expect(stepMoment(clicked, 1, MINUTE, from, to)).toBe(TEN + MINUTE);
    expect(stepMoment(clicked, -1, MINUTE, from, to)).toBe(TEN);
  });

  it("should stay inside the shown range", () => {
    expect(stepMoment(to, 1, MINUTE, from, to)).toBe(to);
    expect(stepMoment(from + 5 * MINUTE, -1, SHIFT_STEP, from, to)).toBe(from);
  });
});
