import { canGoLater, periodRange, periodTitle, shiftPeriod } from "../../src/renderer/period";

/** Local midnight on a day in November 2026 (the 1st was a Sunday). */
const nov = (day: number) => new Date(2026, 10, day).getTime();
/** Friday 13 November 2026, mid-afternoon. */
const now = new Date(2026, 10, 13, 15).getTime();

describe("periodRange", () => {
  it("should run this week from Monday up to the end of today", () => {
    expect(periodRange("week", now, now)).toEqual({ from: nov(9), to: nov(14) });
  });

  it("should count Sunday as the end of the week, not the start", () => {
    expect(periodRange("week", nov(8), now)).toEqual({ from: nov(2), to: nov(9) });
  });

  it("should take the last 7 days as the picked day and the six before it", () => {
    expect(periodRange("last7", now, now)).toEqual({ from: nov(7), to: nov(14) });
  });

  it("should run this month from the 1st to the end of today, and a past month to its end", () => {
    expect(periodRange("month", now, now)).toEqual({ from: nov(1), to: nov(14) });
    expect(periodRange("month", new Date(2026, 9, 20).getTime(), now)).toEqual({ from: new Date(2026, 9, 1).getTime(), to: nov(1) });
  });
});

describe("shiftPeriod", () => {
  it("should step a week or 7 days at a time, and a month to the month before", () => {
    expect(shiftPeriod("week", now, -1, now)).toBe(nov(6));
    expect(shiftPeriod("last7", now, -1, now)).toBe(nov(6));
    expect(shiftPeriod("month", now, -1, now)).toBe(new Date(2026, 9, 1).getTime());
    expect(shiftPeriod("day", now, -1, now)).toBe(nov(12));
  });

  it("should never step past today", () => {
    expect(shiftPeriod("week", nov(10), 1, now)).toBe(nov(13));
    expect(shiftPeriod("month", new Date(2026, 9, 20).getTime(), 1, now)).toBe(nov(1));
  });
});

describe("canGoLater", () => {
  it("should only allow moving forward once the next period has started", () => {
    expect(canGoLater("week", now, now)).toBe(false);
    expect(canGoLater("week", nov(5), now)).toBe(true);
    expect(canGoLater("month", now, now)).toBe(false);
    expect(canGoLater("last7", now, now)).toBe(false);
    expect(canGoLater("last7", nov(12), now)).toBe(true);
  });
});

describe("periodTitle", () => {
  it("should name this week, last week and older weeks plainly", () => {
    expect(periodTitle("week", now, now)).toBe("This week so far");
    expect(periodTitle("week", nov(4), now)).toBe("Last week");
    expect(periodTitle("week", new Date(2026, 9, 28).getTime(), now)).toMatch(/^Week of .*October 26/);
  });

  it("should name the last 7 days and months, saying when they're not over yet", () => {
    expect(periodTitle("last7", now, now)).toBe("Last 7 days");
    expect(periodTitle("last7", nov(10), now)).toMatch(/^7 days to .*November 10/);
    expect(periodTitle("month", now, now)).toBe("November so far");
    expect(periodTitle("month", new Date(2026, 9, 5).getTime(), now)).toBe("October 2026");
  });
});
