import { ActivityStore, type NewSegment } from "../../src/main/activity/ActivityStore";
import { STARTER_RULES } from "../../src/main/activity/classify";
import { localDayBounds } from "../../src/main/activity/dayReport";
import { buildRangeReport } from "../../src/main/activity/rangeReport";
import { Store } from "../../src/main/store/Store";

/** A stretch with defaults for the fields a test doesn't care about. */
const segment = (fields: Partial<NewSegment>): NewSegment => ({
  startedAt: 0,
  endedAt: 0,
  kind: "active",
  app: null,
  bundleId: null,
  title: null,
  url: null,
  domain: null,
  project: null,
  ...fields,
});

const MIN = 60_000;

describe("buildRangeReport", () => {
  let store: Store;
  let activity: ActivityStore;
  /** Monday 2 November 2026. */
  const monday = localDayBounds(new Date(2026, 10, 2, 12).getTime()).dayStart;
  /** Nine in the morning on the day so many days after Monday. */
  const nineOn = (days: number) => new Date(2026, 10, 2 + days, 9).getTime();

  beforeEach(() => {
    store = new Store(":memory:");
    activity = new ActivityStore(store.db);
  });

  afterEach(() => {
    store.close();
  });

  it("should add the days up and keep each day's split for its bar", () => {
    activity.insertSegment(segment({ startedAt: nineOn(0), endedAt: nineOn(0) + 30 * MIN, app: "WebStorm", project: "time-center" }));
    activity.insertSegment(segment({ startedAt: nineOn(2), endedAt: nineOn(2) + 20 * MIN, app: "WebStorm", project: "time-center" }));
    activity.insertSegment(segment({ startedAt: nineOn(2) + 20 * MIN, endedAt: nineOn(2) + 30 * MIN, app: "Google Chrome", domain: "github.com" }));
    activity.insertSegment(segment({ startedAt: nineOn(2) + 30 * MIN, endedAt: nineOn(2) + 40 * MIN, kind: "idle" }));

    const report = buildRangeReport(activity, STARTER_RULES, monday, new Date(2026, 10, 5).getTime());

    expect(report.from).toBe(monday);
    expect(report.to).toBe(new Date(2026, 10, 5).getTime());
    expect(report.days.map((day) => [new Date(day.dayStart).getDate(), day.activeMs / MIN])).toEqual([
      [2, 30],
      [3, 0],
      [4, 30],
    ]);
    expect(report.days[2].byCategory).toEqual([
      { name: "Coding", ms: 20 * MIN },
      { name: "Code review", ms: 10 * MIN },
    ]);
    expect(report.activeMs).toBe(60 * MIN);
    expect(report.idleMs).toBe(10 * MIN);
    expect(report.byCategory).toEqual([
      { name: "Coding", ms: 50 * MIN },
      { name: "Code review", ms: 10 * MIN },
    ]);
    expect(report.byProject).toEqual([{ name: "time-center", ms: 50 * MIN }]);
    expect(report.byDomain).toEqual([{ name: "github.com", ms: 10 * MIN }]);
  });

  it("should add a repeating meeting's time across its days, leaving out ones you weren't in", () => {
    const meetings = [0, 1, 3].map((days) => ({
      eventId: `dsu-${days}`, title: "DSU", start: nineOn(days), end: nineOn(days) + 15 * MIN, response: "accepted",
      type: "dsu" as const, typeSource: "you" as const, joinUrl: "https://zoom.us/j/1", attendees: [{ email: "sam@qbdvision.com", name: null }],
    }));
    for (const days of [0, 1]) {
      activity.insertSegment(segment({ startedAt: nineOn(days), endedAt: nineOn(days) + 15 * MIN, app: "Zoom", onCall: true }));
    }

    const report = buildRangeReport(activity, STARTER_RULES, monday, new Date(2026, 10, 9).getTime(), (from, to) =>
      meetings.filter((meeting) => meeting.start < to && meeting.end > from),
    );

    expect(report.days).toHaveLength(7);
    expect(report.byMeeting).toEqual([{ name: "DSU", ms: 30 * MIN }]);
  });

  it("should stop at a month and a day however long the range asked for", () => {
    const report = buildRangeReport(activity, STARTER_RULES, monday, monday + 90 * 86_400_000);
    expect(report.days).toHaveLength(32);
  });
});
