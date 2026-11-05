import { describe, expect, it } from "vitest";
import { MINUTE } from "../../src/renderer/timelineStep";
import { keepInView, MIN_SPAN, panRange, tickMoments, zoomRange } from "../../src/renderer/timelineZoom";

/** 08:00 and 18:00 on some day; the timeline's whole range. */
const EIGHT = Date.UTC(2026, 10, 5, 8);
const HOUR = 60 * MINUTE;
const full = { from: EIGHT, to: EIGHT + 10 * HOUR };

describe("zoomRange", () => {
  it("should narrow the range when scrolling up, keeping the anchor at the same spot", () => {
    const anchor = EIGHT + 5 * HOUR;
    const zoomed = zoomRange(full, full, anchor, -100);
    expect(zoomed.to - zoomed.from).toBeCloseTo((10 * HOUR) / 1.25);
    expect((anchor - zoomed.from) / (zoomed.to - zoomed.from)).toBeCloseTo(0.5);
  });

  it("should never zoom in past the narrowest span", () => {
    const zoomed = zoomRange(full, full, EIGHT + HOUR, -10_000);
    expect(zoomed.to - zoomed.from).toBe(MIN_SPAN);
  });

  it("should never zoom out past the whole range", () => {
    const view = { from: EIGHT + HOUR, to: EIGHT + 2 * HOUR };
    expect(zoomRange(view, full, EIGHT + 90 * MINUTE, 10_000)).toEqual(full);
  });

  it("should stay inside the whole range when zooming out near an edge", () => {
    const view = { from: EIGHT, to: EIGHT + HOUR };
    const zoomed = zoomRange(view, full, EIGHT, 300);
    expect(zoomed.from).toBe(EIGHT);
    expect(zoomed.to).toBeLessThanOrEqual(full.to);
  });
});

describe("panRange", () => {
  it("should slide the range without changing its width, stopping at the edges", () => {
    const view = { from: EIGHT + HOUR, to: EIGHT + 2 * HOUR };
    expect(panRange(view, full, 30 * MINUTE)).toEqual({ from: EIGHT + 90 * MINUTE, to: EIGHT + 150 * MINUTE });
    expect(panRange(view, full, -5 * HOUR)).toEqual({ from: EIGHT, to: EIGHT + HOUR });
  });
});

describe("keepInView", () => {
  const view = { from: EIGHT + HOUR, to: EIGHT + 2 * HOUR };

  it("should leave the range alone when the moment is already on it", () => {
    expect(keepInView(view, full, EIGHT + 90 * MINUTE)).toBe(view);
  });

  it("should slide the range just far enough to show a moment past either edge", () => {
    expect(keepInView(view, full, EIGHT + 2 * HOUR + MINUTE).to).toBe(EIGHT + 2 * HOUR + MINUTE);
    expect(keepInView(view, full, EIGHT + HOUR - MINUTE).from).toBe(EIGHT + HOUR - MINUTE);
  });
});

describe("tickMoments", () => {
  it("should label every hour across a whole working day", () => {
    expect(tickMoments(full, EIGHT - 8 * HOUR)).toHaveLength(11);
  });

  it("should label round minutes, all inside the range, when zoomed in", () => {
    const view = { from: EIGHT + 7 * MINUTE, to: EIGHT + 47 * MINUTE };
    const ticks = tickMoments(view, EIGHT - 8 * HOUR);
    expect(ticks[0]).toBe(EIGHT + 10 * MINUTE);
    expect(ticks.every((tick) => tick % (5 * MINUTE) === 0 && tick >= view.from && tick <= view.to)).toBe(true);
  });
});
