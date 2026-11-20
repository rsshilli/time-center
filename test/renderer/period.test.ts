import { activePreset, canGoLater, periodRange, periodTitle, presetView, shiftPeriod } from "../../src/renderer/period";

/** Local midnight on a day in November 2026 (the 1st was a Sunday). */
const nov = (day: number) => new Date(2026, 10, day).getTime();
/** Local midnight on a day in October 2026. */
const oct = (day: number) => new Date(2026, 9, day).getTime();
/** Friday 13 November 2026, mid-afternoon. */
const now = new Date(2026, 10, 13, 15).getTime();

describe("periodRange", () => {
  it("should run this week from Monday up to the end of today", () => {
    expect(periodRange("week", now, now)).toEqual({ from: nov(9), to: nov(14) });
  });

  it("should count Sunday as the end of the week, not the start", () => {
    expect(periodRange("week", nov(8), now)).toEqual({ from: nov(2), to: nov(9) });
  });

  it("should take 4 weeks as the picked day and the 27 before it, across a month's end", () => {
    expect(periodRange("fourWeeks", now, now)).toEqual({ from: oct(17), to: nov(14) });
  });
});

describe("shiftPeriod", () => {
  it("should step a day, a week or 4 weeks at a time", () => {
    expect(shiftPeriod("day", now, -1, now)).toBe(nov(12));
    expect(shiftPeriod("week", now, -1, now)).toBe(nov(6));
    expect(shiftPeriod("fourWeeks", now, -1, now)).toBe(oct(16));
  });

  it("should never step past today", () => {
    expect(shiftPeriod("week", nov(10), 1, now)).toBe(nov(13));
    expect(shiftPeriod("fourWeeks", nov(1), 1, now)).toBe(nov(13));
  });
});

describe("canGoLater", () => {
  it("should only allow moving forward when there's something later to show", () => {
    expect(canGoLater("week", now, now)).toBe(false);
    expect(canGoLater("week", nov(5), now)).toBe(true);
    expect(canGoLater("fourWeeks", now, now)).toBe(false);
    expect(canGoLater("fourWeeks", nov(1), now)).toBe(true);
    expect(canGoLater("day", now, now)).toBe(false);
    expect(canGoLater("day", nov(12), now)).toBe(true);
  });
});

describe("periodTitle", () => {
  it("should name this week, last week and older weeks plainly", () => {
    expect(periodTitle("week", now, now)).toBe("This week so far");
    expect(periodTitle("week", nov(4), now)).toBe("Last week");
    expect(periodTitle("week", oct(28), now)).toMatch(/^Week of .*October 26/);
  });

  it("should name the last 4 weeks, and an earlier 4 weeks by the day it ends", () => {
    expect(periodTitle("fourWeeks", now, now)).toBe("Last 4 weeks");
    expect(periodTitle("fourWeeks", oct(16), now)).toMatch(/^4 weeks to .*October 16/);
  });
});

describe("presetView", () => {
  it("should keep the picked day for Day, and jump to this week, last week and the last 4 weeks", () => {
    expect(presetView("day", nov(4), now)).toEqual({ period: "day", at: nov(4) });
    expect(presetView("thisWeek", nov(4), now)).toEqual({ period: "week", at: nov(13) });
    expect(presetView("lastWeek", nov(4), now)).toEqual({ period: "week", at: nov(2) });
    expect(presetView("last4Weeks", nov(4), now)).toEqual({ period: "fourWeeks", at: nov(13) });
  });
});

describe("activePreset", () => {
  it("should light the button that matches what's showing", () => {
    expect(activePreset("day", nov(4), now)).toBe("day");
    expect(activePreset("week", nov(11), now)).toBe("thisWeek");
    expect(activePreset("week", nov(5), now)).toBe("lastWeek");
    expect(activePreset("fourWeeks", now, now)).toBe("last4Weeks");
  });

  it("should light none when the arrows moved somewhere no button names", () => {
    expect(activePreset("week", oct(28), now)).toBeNull();
    expect(activePreset("fourWeeks", oct(16), now)).toBeNull();
  });
});
