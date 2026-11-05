import { describe, expect, it } from "vitest";
import { MINUTE, SHIFT_STEP, stepMoment } from "../../src/renderer/timelineStep";

/** 10:00 on some day, on a minute mark. */
const TEN = Date.UTC(2026, 10, 5, 10, 0, 0);

describe("stepMoment", () => {
  const from = TEN - 60 * MINUTE;
  const to = TEN + 60 * MINUTE;

  it("should move one minute later on Right from a minute mark", () => {
    expect(stepMoment(TEN, 1, MINUTE, from, to)).toBe(TEN + MINUTE);
  });

  it("should move one minute earlier on Left from a minute mark", () => {
    expect(stepMoment(TEN, -1, MINUTE, from, to)).toBe(TEN - MINUTE);
  });

  it("should land on whole minutes when starting between marks", () => {
    const clicked = TEN + 30_000;
    expect(stepMoment(clicked, 1, MINUTE, from, to)).toBe(TEN + MINUTE);
    expect(stepMoment(clicked, -1, MINUTE, from, to)).toBe(TEN);
  });

  it("should move ten minutes with the Shift step", () => {
    expect(stepMoment(TEN, 1, SHIFT_STEP, from, to)).toBe(TEN + 10 * MINUTE);
  });

  it("should stay inside the shown range", () => {
    expect(stepMoment(to, 1, MINUTE, from, to)).toBe(to);
    expect(stepMoment(from + 5 * MINUTE, -1, SHIFT_STEP, from, to)).toBe(from);
  });
});
