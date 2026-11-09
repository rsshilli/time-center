import { shiftDay, startOfDay } from "../../src/renderer/day";

describe("startOfDay", () => {
  it("should return the local midnight of a moment's day", () => {
    expect(startOfDay(new Date(2026, 10, 9, 15, 42).getTime())).toBe(new Date(2026, 10, 9).getTime());
  });
});

describe("shiftDay", () => {
  it("should step one calendar day back or forward, even across a clock change or a month end", () => {
    expect(shiftDay(new Date(2026, 10, 9, 15).getTime(), -1)).toBe(new Date(2026, 10, 8).getTime());
    expect(shiftDay(new Date(2026, 10, 30, 23).getTime(), 1)).toBe(new Date(2026, 11, 1).getTime());
    // US clocks fall back on November 1, 2026: that day is 25 hours long.
    expect(shiftDay(new Date(2026, 10, 1, 0, 30).getTime(), 1)).toBe(new Date(2026, 10, 2).getTime());
    expect(shiftDay(new Date(2026, 10, 2, 0, 30).getTime(), -1)).toBe(new Date(2026, 10, 1).getTime());
  });
});
