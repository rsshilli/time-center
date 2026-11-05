import { ActivityStore } from "../../src/main/activity/ActivityStore";
import { IDLE_AFTER_MS, SegmentRecorder, type WindowSample } from "../../src/main/activity/SegmentRecorder";
import { Store } from "../../src/main/store/Store";

/** A sample of an app in front. */
const sample = (fields: Partial<WindowSample> = {}): WindowSample => ({
  app: "WebStorm",
  bundleId: "com.jetbrains.WebStorm",
  title: "time-center – PLAN.md",
  url: null,
  ignored: false,
  ...fields,
});

/** 9:00 on some day. */
const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);

describe("SegmentRecorder", () => {
  let store: Store;
  let activity: ActivityStore;
  let recorder: SegmentRecorder;

  beforeEach(() => {
    store = new Store(":memory:");
    activity = new ActivityStore(store.db);
    recorder = new SegmentRecorder(activity);
  });

  afterEach(() => {
    store.close();
  });

  /** Every stored stretch. */
  const all = () => activity.listSegments(0, Date.UTC(3000, 0, 1));

  it("should extend one stretch while the same window stays in front", () => {
    recorder.record(sample(), T0, 0);
    recorder.record(sample(), T0 + 3000, 0);
    recorder.record(sample(), T0 + 6000, 0);
    expect(all()).toHaveLength(1);
    expect(all()[0]).toMatchObject({ startedAt: T0, endedAt: T0 + 6000, kind: "active", project: "time-center" });
  });

  it("should start a new stretch where the previous one ends when the window changes", () => {
    recorder.record(sample(), T0, 0);
    recorder.record(sample({ app: "Google Chrome", bundleId: "com.google.Chrome", title: "PR", url: "https://github.com/x" }), T0 + 3000, 0);
    const [first, second] = all();
    expect(first.endedAt).toBe(T0 + 3000);
    expect(second).toMatchObject({ startedAt: T0 + 3000, domain: "github.com", project: null });
  });

  it("should not stretch across a gap left by sleep", () => {
    recorder.record(sample(), T0, 0);
    recorder.record(sample(), T0 + 60_000, 0);
    const [first, second] = all();
    expect(first.endedAt).toBe(T0);
    expect(second.startedAt).toBe(T0 + 60_000);
  });

  it("should store nothing about an ignored app but the time", () => {
    recorder.record(sample({ app: "Microsoft Edge", bundleId: "com.microsoft.edgemac", title: "secret", ignored: true }), T0, 0);
    expect(all()[0]).toMatchObject({ kind: "untracked", app: null, bundleId: null, title: null, url: null });
  });

  it("should move the time since the last input into an away stretch after five minutes", () => {
    recorder.record(sample(), T0, 0);
    for (let at = T0 + 3000; at <= T0 + IDLE_AFTER_MS; at += 3000) {
      recorder.record(sample(), at, at - T0 - 3000);
    }
    // The last input was at T0 + 3 s; the sample at T0 + 5 min has been idle for 4:57 — not yet away.
    recorder.record(sample(), T0 + IDLE_AFTER_MS + 3000, IDLE_AFTER_MS);
    const [work, away] = all();
    expect(work).toMatchObject({ kind: "active", endedAt: T0 + 3000 });
    expect(away).toMatchObject({ kind: "idle", startedAt: T0 + 3000, endedAt: T0 + IDLE_AFTER_MS + 3000 });
  });

  it("should not count time on a call as away, however long without input", () => {
    // 9:47 to 10:00 on a Zoom call, talking and listening, never touching the keyboard.
    recorder.record(sample(), T0, 0);
    for (let at = T0 + 3000; at <= T0 + 13 * 60_000; at += 3000) {
      recorder.record(sample({ app: "zoom.us", bundleId: "us.zoom.xos", title: "Zoom Meeting", onCall: true }), at, at - T0);
    }
    expect(all().map((segment) => segment.kind)).toEqual(["active", "active"]);
  });

  it("should count away time from the end of the call, not from the last input", () => {
    recorder.record(sample(), T0, 0);
    const callEnd = T0 + 10 * 60_000;
    for (let at = T0 + 3000; at <= callEnd + IDLE_AFTER_MS + 3000; at += 3000) {
      recorder.record(sample({ onCall: at <= callEnd }), at, at - T0);
    }
    const away = all().filter((segment) => segment.kind === "idle");
    expect(away).toHaveLength(1);
    expect(away[0].startedAt).toBe(callEnd);
  });

  it("should extend the away stretch while still away and end it on return", () => {
    recorder.record(sample(), T0, IDLE_AFTER_MS);
    recorder.record(sample(), T0 + 3000, IDLE_AFTER_MS + 3000);
    recorder.record(sample(), T0 + 6000, 0);
    const [away, back] = all();
    expect(away).toMatchObject({ kind: "idle", startedAt: T0 - IDLE_AFTER_MS, endedAt: T0 + 6000 });
    expect(back).toMatchObject({ kind: "active", startedAt: T0 + 6000 });
  });

  it("should not start an away stretch before the end of a stretch closed by sleep", () => {
    recorder.record(sample(), T0, 0);
    recorder.record(sample(), T0 + 600_000, IDLE_AFTER_MS * 2);
    const [, away] = all();
    expect(away.startedAt).toBe(T0);
  });

  it("should not start away time before what an earlier run of the app recorded", () => {
    recorder.record(sample(), T0, 0);
    recorder.record(sample(), T0 + 3000, 0);
    const restarted = new SegmentRecorder(activity);
    restarted.record(sample(), T0 + 60_000, IDLE_AFTER_MS);
    const [, away] = all();
    expect(away).toMatchObject({ kind: "idle", startedAt: T0 + 3000, endedAt: T0 + 60_000 });
  });

  it("should close the open stretch on pause and report nothing open afterwards", () => {
    recorder.record(sample(), T0, 0);
    recorder.pause(T0 + 2000);
    expect(all()[0].endedAt).toBe(T0 + 2000);
    expect(recorder.current()).toBeNull();
    recorder.record(sample(), T0 + 4000, 0);
    expect(all()).toHaveLength(2);
  });
});
