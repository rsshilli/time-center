import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityStore } from "../../src/main/activity/ActivityStore";
import { ScreenCapturer, localStamp, type ScreenCapturerDeps } from "../../src/main/screenshots/ScreenCapturer";
import { Store } from "../../src/main/store/Store";
import type { SegmentKind } from "../../src/shared/ipc";

const MINUTE = new Date(2026, 10, 4, 9, 31).getTime();

describe("ScreenCapturer", () => {
  let dir: string;
  let store: Store;
  let activity: ActivityStore;
  let clock: number;
  let segment: { id: number; kind: SegmentKind } | null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tc-shots-"));
    store = new Store(":memory:");
    activity = new ActivityStore(store.db);
    clock = MINUTE;
    segment = { id: 1, kind: "active" };
    store.db.exec(
      "INSERT INTO activity_segments (started_at, ended_at, kind) VALUES ('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'active')",
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** A capturer whose CPU readings come from a list, one per check, each taking a second. */
  const build = (cpuReadings: number[], overrides: Partial<ScreenCapturerDeps> = {}) =>
    new ScreenCapturer({
      activity,
      currentSegment: () => segment,
      canCapture: () => true,
      sampleCpuPercent: async () => {
        clock += 1000;
        return cpuReadings.shift() ?? 100;
      },
      captureDisplays: async () => [
        { displayId: "1", full: Buffer.from("full-1"), thumb: Buffer.from("t1") },
        { displayId: "2", full: Buffer.from("full-2"), thumb: Buffer.from("t2") },
      ],
      screenshotsDir: dir,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      ...overrides,
    });

  /** Every screenshot row. */
  const rows = () => activity.listScreenshots(0, Date.UTC(3000, 0, 1));

  it("should capture every display at once when the CPU is quiet", async () => {
    expect(await startedRun(build([10]))).toBe("taken");
    expect(rows().map((row) => [row.status, row.displayId, row.segmentId])).toEqual([
      ["taken", "1", 1],
      ["taken", "2", 1],
    ]);
    expect(await readdir(join(dir, localStamp(MINUTE).day))).toHaveLength(4);
  });

  it("should run on every half-minute mark", async () => {
    const capturer = build([], { now: () => Date.now() });
    const run = vi.spyOn(capturer, "runMark").mockResolvedValue("taken");
    vi.useFakeTimers({ now: MINUTE + 10_000 });
    try {
      capturer.start();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(run).toHaveBeenLastCalledWith(MINUTE + 30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenLastCalledWith(MINUTE + 60_000);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      capturer.stop();
      vi.useRealTimers();
    }
  });

  it("should wait for the CPU to calm down within 15 seconds", async () => {
    const capturer = build([80, 80, 20]);
    expect(await startedRun(capturer)).toBe("taken");
    expect(rows()[0].cpuPercent).toBe(20);
  });

  it("should skip the mark when the CPU stays busy for 15 seconds", async () => {
    const readings: number[] = [];
    const capturer = build([], {
      sampleCpuPercent: async () => {
        readings.push(clock - MINUTE);
        clock += 1000;
        return 90;
      },
    });
    expect(await startedRun(capturer)).toBe("skipped-busy");
    expect(rows()).toMatchObject([{ status: "skipped-busy", path: null, cpuPercent: 90 }]);
    expect(Math.max(...readings)).toBeLessThanOrEqual(15_000);
  });

  it("should take nothing while away", async () => {
    segment = { id: 1, kind: "idle" };
    expect(await startedRun(build([10]))).toBe("not-recording");
    expect(rows()).toEqual([]);
  });

  it("should take nothing while Edge is in front", async () => {
    segment = { id: 1, kind: "untracked" };
    expect(await startedRun(build([10]))).toBe("not-recording");
  });

  it("should take nothing while locked or asleep", async () => {
    segment = null;
    expect(await startedRun(build([10]))).toBe("not-recording");
  });

  it("should take nothing without the Screen Recording permission", async () => {
    expect(await startedRun(build([10], { canCapture: () => false }))).toBe("not-recording");
  });

  it("should save nothing, and say why, when the capture itself fails", async () => {
    const capturer = build([10], {
      captureDisplays: async () => {
        throw new Error("The screenshot helper failed: no permission");
      },
    });
    await expect(startedRun(capturer)).rejects.toThrow(/no permission/);
    expect(rows()).toEqual([]);
  });

  it("should save nothing when Edge came to the front during the capture", async () => {
    const capturer = build([10], {
      captureDisplays: async () => {
        segment = { id: 2, kind: "untracked" };
        return [{ displayId: "1", full: Buffer.from("f"), thumb: Buffer.from("t") }];
      },
    });
    expect(await startedRun(capturer)).toBe("skipped-private");
    expect(rows()).toEqual([]);
  });

  it("should drop a mark whose timer fired late, after the Mac slept", async () => {
    clock = MINUTE + 10 * 60_000;
    expect(await startedRun(build([90]))).toBe("not-recording");
    expect(rows()).toEqual([]);
  });
});

describe("localStamp", () => {
  it("should give different file names to the two 1 a.m. hours on the night clocks go back", () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/Chicago";
    try {
      const first = localStamp(Date.UTC(2026, 10, 1, 6, 30));
      const second = localStamp(Date.UTC(2026, 10, 1, 7, 30));
      expect(first.time).toBe(second.time);
      expect(first.time + first.zone).not.toBe(second.time + second.zone);
      expect([first.zone, second.zone]).toEqual(["-0500", "-0600"]);
    } finally {
      process.env.TZ = zone;
    }
  });
});

/**
 * Runs one mark on a capturer that has been started (stop() makes it refuse to capture).
 * @param capturer The capturer.
 * @returns What the mark did.
 */
async function startedRun(capturer: ScreenCapturer) {
  vi.useFakeTimers();
  try {
    capturer.start();
    return await capturer.runMark(MINUTE);
  } finally {
    capturer.stop();
    vi.useRealTimers();
  }
}
