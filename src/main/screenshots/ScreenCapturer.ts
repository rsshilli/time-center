import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SegmentKind } from "../../shared/ipc";
import type { ActivityStore } from "../activity/ActivityStore";

/** Take a screenshot only while total CPU use is under this percentage (user's pick). */
export const CPU_LIMIT_PERCENT = 30;

/** How often a screenshot is taken: on every half-minute mark (user's pick). */
export const SHOT_EVERY_MS = 30_000;

/** While the CPU is busy, check again this often... */
export const RETRY_EVERY_MS = 5_000;

/** ...for up to this long after the mark, then skip it. Half the gap, so a late shot sits nearer its own mark. */
export const GIVE_UP_AFTER_MS = 15_000;

/** One display's picture, already encoded. */
export interface DisplayCapture {
  displayId: string;
  full: Buffer;
  thumb: Buffer;
}

/** What one mark did, for tests and logs. */
export type ShotResult = "taken" | "skipped-busy" | "skipped-private" | "not-recording";

/** What the capturer needs, injected so tests run without Electron or a real clock. */
export interface ScreenCapturerDeps {
  activity: Pick<ActivityStore, "insertScreenshot">;
  /** The stretch being recorded; null while locked, asleep or between stretches. */
  currentSegment(): { id: number; kind: SegmentKind } | null;
  /** Whether macOS allows screen capture; without it shots come out blank. */
  canCapture(): boolean;
  /** Total CPU use across all cores, measured over a short window. */
  sampleCpuPercent(): Promise<number>;
  /** Pictures of every display, as JPEGs, with the ignored apps' windows left out. */
  captureDisplays(): Promise<DisplayCapture[]>;
  /** Folder that holds one sub-folder of screenshots per day. */
  screenshotsDir: string;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Takes a screenshot of every display every 30 seconds, on the :00 and :30 marks, but only while the CPU
 * is quiet. A busy CPU is re-checked every 5 seconds for up to 15 seconds, then the mark is recorded as
 * skipped. Nothing queues: a missed mark is dropped and the next one starts fresh. No shot is taken
 * while away, locked, asleep, or while an ignored app (Edge) is in front, and Edge windows elsewhere on
 * screen are cut out of the pictures. Files stay on this Mac.
 */
export class ScreenCapturer {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  /** @param deps The tracker, storage, clock and Electron capture calls. */
  constructor(private readonly deps: ScreenCapturerDeps) {}

  /** Starts waiting for the next mark. */
  start(): void {
    this.stopped = false;
    this.scheduleNextMark();
  }

  /** Sets a timer for the next half-minute mark; each run schedules the following one when it ends. */
  private scheduleNextMark(): void {
    if (this.stopped) {
      return;
    }
    const now = this.deps.now();
    const nextMark = Math.floor(now / SHOT_EVERY_MS) * SHOT_EVERY_MS + SHOT_EVERY_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runMark(nextMark)
        .catch((error: unknown) => console.error("Time Center: screenshot failed", error))
        .finally(() => this.scheduleNextMark());
    }, nextMark - now);
  }

  /**
   * Handles one mark: waits for a quiet CPU, then captures, or records the mark as skipped.
   * @param markStart The mark.
   * @returns What happened.
   */
  async runMark(markStart: number): Promise<ShotResult> {
    // Timers don't run while the Mac sleeps, so one can fire long after its mark: drop that mark.
    if (this.deps.now() - markStart > GIVE_UP_AFTER_MS) {
      return "not-recording";
    }
    while (true) {
      if (!this.shouldCapture()) {
        return "not-recording";
      }
      const cpu = await this.deps.sampleCpuPercent();
      if (cpu < CPU_LIMIT_PERCENT) {
        return (await this.capture(cpu)) > 0 ? "taken" : "skipped-private";
      }
      if (this.deps.now() + RETRY_EVERY_MS - markStart > GIVE_UP_AFTER_MS) {
        this.deps.activity.insertScreenshot({
          takenAt: markStart,
          status: "skipped-busy",
          displayId: null,
          path: null,
          thumbPath: null,
          bytes: null,
          cpuPercent: cpu,
          segmentId: this.deps.currentSegment()?.id ?? null,
        });
        return "skipped-busy";
      }
      await this.deps.sleep(RETRY_EVERY_MS);
    }
  }

  /**
   * Says whether a shot may be taken now: recording active time, not away or in Edge, with permission.
   * @returns True when it may.
   */
  private shouldCapture(): boolean {
    return !this.stopped && this.deps.currentSegment()?.kind === "active" && this.deps.canCapture();
  }

  /**
   * Captures every display and stores each picture and its thumbnail under the day's folder. The
   * pictures are thrown away if the stretch in front changed during the capture (say Edge came to the
   * front), since the window sample that allowed the shot may then be out of date.
   * @param cpu The CPU reading that allowed it.
   * @returns How many displays were saved.
   */
  private async capture(cpu: number): Promise<number> {
    const takenAt = this.deps.now();
    // Linked to the stretch in front when the shot was taken, read before the slow capture.
    const segmentId = this.deps.currentSegment()?.id ?? null;
    const displays = await this.deps.captureDisplays();
    if (!this.shouldCapture() || this.deps.currentSegment()?.id !== segmentId) {
      return 0;
    }
    const { day, time, zone } = localStamp(takenAt);
    const dir = join(this.deps.screenshotsDir, day);
    await mkdir(dir, { recursive: true });
    for (const display of displays) {
      // The UTC offset keeps the repeated hour, on the night the clocks go back, from overwriting files.
      const base = `${time}${zone}-${display.displayId.replace(/[^\w-]/g, "_")}`;
      const path = join(dir, `${base}.jpg`);
      const thumbPath = join(dir, `${base}-thumb.jpg`);
      await writeFile(path, display.full);
      await writeFile(thumbPath, display.thumb);
      this.deps.activity.insertScreenshot({
        takenAt,
        status: "taken",
        displayId: display.displayId,
        path,
        thumbPath,
        bytes: display.full.length + display.thumb.length,
        cpuPercent: cpu,
        segmentId,
      });
    }
    return displays.length;
  }

  /** Stops taking screenshots. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Formats a moment as the day folder and file-name time, in local time.
 * @param ms The moment.
 * @returns e.g. { day: "2026-11-04", time: "093105", zone: "-0600" }.
 */
export function localStamp(ms: number): { day: string; time: string; zone: string } {
  const date = new Date(ms);
  /**
   * Pads a number to two digits.
   * @param value The number.
   * @returns e.g. "07".
   */
  const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    zone: `${offset < 0 ? "-" : "+"}${pad(Math.trunc(offset / 60))}${pad(offset % 60)}`,
  };
}
