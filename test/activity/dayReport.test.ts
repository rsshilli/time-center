import { ActivityStore, type NewSegment } from "../../src/main/activity/ActivityStore";
import { STARTER_RULES } from "../../src/main/activity/classify";
import { buildDayReport, localDayBounds } from "../../src/main/activity/dayReport";
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

describe("buildDayReport", () => {
  let store: Store;
  let activity: ActivityStore;
  const { dayStart, dayEnd } = localDayBounds(new Date(2026, 10, 4, 12).getTime());

  beforeEach(() => {
    store = new Store(":memory:");
    activity = new ActivityStore(store.db);
  });

  afterEach(() => {
    store.close();
  });

  it("should total active, away and untracked time and group active time", () => {
    const nine = dayStart + 9 * 60 * MIN;
    activity.insertSegment(segment({ startedAt: nine, endedAt: nine + 30 * MIN, app: "WebStorm", project: "time-center" }));
    activity.insertSegment(
      segment({ startedAt: nine + 30 * MIN, endedAt: nine + 40 * MIN, app: "Google Chrome", domain: "github.com" }),
    );
    activity.insertSegment(segment({ startedAt: nine + 40 * MIN, endedAt: nine + 50 * MIN, kind: "idle" }));
    activity.insertSegment(segment({ startedAt: nine + 50 * MIN, endedAt: nine + 55 * MIN, kind: "untracked" }));

    const report = buildDayReport(activity, STARTER_RULES, dayStart + MIN);

    expect(report.activeMs).toBe(40 * MIN);
    expect(report.idleMs).toBe(10 * MIN);
    expect(report.untrackedMs).toBe(5 * MIN);
    expect(report.byCategory).toEqual([
      { name: "Coding", ms: 30 * MIN },
      { name: "Code review", ms: 10 * MIN },
    ]);
    expect(report.byProject).toEqual([{ name: "time-center", ms: 30 * MIN }]);
    expect(report.byDomain).toEqual([{ name: "github.com", ms: 10 * MIN }]);
    expect(report.timeline.map((item) => item.category)).toEqual(["Coding", "Code review", "Away", "Untracked"]);
  });

  it("should clip a stretch that crosses midnight to the day", () => {
    activity.insertSegment(segment({ startedAt: dayStart - 10 * MIN, endedAt: dayStart + 5 * MIN, app: "WebStorm" }));
    activity.insertSegment(segment({ startedAt: dayEnd - 5 * MIN, endedAt: dayEnd + 10 * MIN, app: "WebStorm" }));
    const report = buildDayReport(activity, STARTER_RULES, dayStart);
    expect(report.activeMs).toBe(10 * MIN);
    expect(report.timeline[0].start).toBe(dayStart);
  });

  it("should apply edited rules to time already recorded", () => {
    activity.insertSegment(segment({ startedAt: dayStart, endedAt: dayStart + MIN, app: "Finder" }));
    const report = buildDayReport(activity, [{ field: "app", pattern: "finder", category: "Admin" }], dayStart);
    expect(report.byCategory).toEqual([{ name: "Admin", ms: MIN }]);
  });

  it("should list the day's screenshots and no others", () => {
    activity.insertScreenshot({
      takenAt: dayStart + MIN,
      status: "taken",
      displayId: "1",
      path: "/a.jpg",
      thumbPath: "/a-thumb.jpg",
      bytes: 10,
      cpuPercent: 5,
      segmentId: null,
    });
    activity.insertScreenshot({
      takenAt: dayEnd + MIN,
      status: "skipped-busy",
      displayId: null,
      path: null,
      thumbPath: null,
      bytes: null,
      cpuPercent: 80,
      segmentId: null,
    });
    const report = buildDayReport(activity, STARTER_RULES, dayStart);
    expect(report.screenshots).toEqual([{ id: 1, takenAt: dayStart + MIN, status: "taken", displayId: "1" }]);
  });
});

describe("localDayBounds", () => {
  it("should run from local midnight to the next local midnight", () => {
    const { dayStart, dayEnd } = localDayBounds(new Date(2026, 10, 4, 15, 30).getTime());
    expect(new Date(dayStart)).toEqual(new Date(2026, 10, 4));
    expect(new Date(dayEnd)).toEqual(new Date(2026, 10, 5));
  });
});
