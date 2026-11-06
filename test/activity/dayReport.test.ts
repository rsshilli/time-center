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

  it("should split meeting time by type and still add every category up to the active total", () => {
    const nine = dayStart + 9 * 60 * MIN;
    activity.insertSegment(segment({ startedAt: dayStart - 20 * MIN, endedAt: dayStart + 10 * MIN, app: "Google Chat", onCall: true }));
    activity.insertSegment(segment({ startedAt: nine, endedAt: nine + 20 * MIN, app: "Zoom" }));
    activity.insertSegment(segment({ startedAt: nine + 20 * MIN, endedAt: nine + 45 * MIN, app: "WebStorm", project: "time-center" }));
    const meetings = [
      { eventId: "late", title: "Late call", start: dayStart - 30 * MIN, end: dayStart + 15 * MIN, response: "accepted", type: "customer" as const, typeSource: "you" as const, joinUrl: null, attendees: [{ email: "a@acme.com", name: null }] },
      { eventId: "1-1", title: "Ryan / Sam", start: nine, end: nine + 30 * MIN, response: "accepted", type: "one-on-one" as const, typeSource: "haiku" as const, joinUrl: "https://zoom.us/j/1", attendees: [{ email: "sam@qbdvision.com", name: null }] },
    ];
    const report = buildDayReport(activity, STARTER_RULES, dayStart + MIN, (from, to) => meetings.filter((m) => m.start < to && m.end > from));
    expect(report.byCategory).toEqual([
      { name: "Meetings · One on ones", ms: 30 * MIN },
      { name: "Coding", ms: 15 * MIN },
      { name: "Meetings · Customer", ms: 10 * MIN },
    ]);
    expect(report.byCategory.reduce((sum, total) => sum + total.ms, 0)).toBe(report.activeMs);
    expect(report.meetings.map((meeting) => [meeting.eventId, meeting.ms / MIN])).toEqual([
      ["late", 10],
      ["1-1", 30],
    ]);
  });

  it("should count a stretch you marked as a phone call toward its meeting, filling only the Away time", () => {
    const ten = dayStart + 10 * 60 * MIN;
    activity.insertSegment(segment({ startedAt: ten, endedAt: ten + 10 * MIN, app: "WebStorm" }));
    activity.insertSegment(segment({ startedAt: ten + 10 * MIN, endedAt: ten + 60 * MIN, kind: "idle" }));
    activity.insertManualEntry({ start: ten, end: ten + 40 * MIN, category: "Meetings · Other", eventId: "ws4" });
    const meetings = [
      { eventId: "ws4", title: "WS4", start: ten, end: ten + 60 * MIN, response: "accepted", type: "customer" as const, typeSource: "haiku" as const, joinUrl: "https://teams.microsoft.com/l/meetup-join/x", attendees: [{ email: "a@lilly.com", name: null }] },
    ];
    const report = buildDayReport(activity, STARTER_RULES, ten, (from, to) => meetings.filter((m) => m.start < to && m.end > from));
    expect(report.byCategory).toEqual([{ name: "Meetings · Customer", ms: 40 * MIN }]);
    expect(report.idleMs).toBe(20 * MIN);
    expect(report.meetings).toEqual([expect.objectContaining({ eventId: "ws4", attended: true, ms: 40 * MIN })]);
  });

  it("should not hand a meeting your time at the Mac when the stretch you linked to it only fills time after it", () => {
    const ten = dayStart + 10 * 60 * MIN;
    activity.insertSegment(segment({ startedAt: ten, endedAt: ten + 60 * MIN, app: "WebStorm" }));
    activity.insertSegment(segment({ startedAt: ten + 60 * MIN, endedAt: ten + 90 * MIN, kind: "idle" }));
    activity.insertManualEntry({ start: ten + 30 * MIN, end: ten + 90 * MIN, category: "Meetings · Other", eventId: "ws4" });
    const meetings = [
      { eventId: "ws4", title: "WS4", start: ten, end: ten + 60 * MIN, response: "accepted", type: "customer" as const, typeSource: "haiku" as const, joinUrl: "https://teams.microsoft.com/l/meetup-join/x", attendees: [{ email: "a@lilly.com", name: null }] },
    ];
    const report = buildDayReport(activity, STARTER_RULES, ten, (from, to) => meetings.filter((m) => m.start < to && m.end > from));
    expect(report.byCategory.find((total) => total.name === "Meetings · Customer")).toBeUndefined();
    expect(report.byCategory).toContainEqual({ name: "Meetings · Other", ms: 30 * MIN });
    expect(report.meetings).toEqual([expect.objectContaining({ eventId: "ws4", attended: false, ms: 0 })]);
  });

  it("should stop filling a stretch once you remove it", () => {
    const ten = dayStart + 10 * 60 * MIN;
    activity.insertSegment(segment({ startedAt: ten, endedAt: ten + 30 * MIN, kind: "idle" }));
    const id = activity.insertManualEntry({ start: ten, end: ten + 30 * MIN, category: "Driving", eventId: null });
    expect(buildDayReport(activity, STARTER_RULES, ten).byCategory).toEqual([{ name: "Driving", ms: 30 * MIN }]);
    activity.deleteManualEntry(id);
    expect(activity.listManualEntries(dayStart, dayEnd)).toEqual([]);
    expect(buildDayReport(activity, STARTER_RULES, ten).idleMs).toBe(30 * MIN);
  });

  it("should keep the category you picked for a stretch with no meeting, even inside a meeting you attended", () => {
    const ten = dayStart + 10 * 60 * MIN;
    activity.insertSegment(segment({ startedAt: ten, endedAt: ten + 30 * MIN, app: "Zoom" }));
    activity.insertSegment(segment({ startedAt: ten + 30 * MIN, endedAt: ten + 60 * MIN, kind: "idle" }));
    activity.insertManualEntry({ start: ten + 30 * MIN, end: ten + 60 * MIN, category: "Driving", eventId: null });
    const meetings = [
      { eventId: "1-1", title: "1-1", start: ten, end: ten + 60 * MIN, response: "accepted", type: "one-on-one" as const, typeSource: "haiku" as const, joinUrl: "https://zoom.us/j/1", attendees: [{ email: "s@qbdvision.com", name: null }] },
    ];
    const report = buildDayReport(activity, STARTER_RULES, ten, (from, to) => meetings.filter((m) => m.start < to && m.end > from));
    expect(report.byCategory).toEqual([
      { name: "Meetings · One on ones", ms: 30 * MIN },
      { name: "Driving", ms: 30 * MIN },
    ]);
    expect(report.timeline.find((item) => item.category === "Driving")?.manual).toEqual({ id: 1, eventId: null });
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
