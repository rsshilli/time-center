import type { SegmentKind } from "../../shared/ipc";
import type { SegmentRecorder, WindowSample } from "./SegmentRecorder";
import type { WindowHelper } from "./windowHelper";

/** How often the helper reports the front window. */
export const SAMPLE_INTERVAL_SECONDS = 3;

/** Wait before restarting a helper that stopped, so a crashing one doesn't spin... */
export const RESTART_DELAY_MS = 10_000;

/** ...doubling after each failed start in a row (e.g. the binary is missing), up to this. */
export const MAX_RESTART_DELAY_MS = 5 * 60_000;

/** What the tracker needs from Electron and the helper, injected for tests. */
export interface ActivityTrackerDeps {
  recorder: SegmentRecorder;
  /** Starts the helper; calls back with each sample and once when it stops. */
  startHelper(onSample: (sample: WindowSample) => void, onExit: (reason: string) => void): WindowHelper;
  /** Milliseconds since the last keyboard or mouse input. */
  getIdleMs(): number;
  now(): number;
  /** Told whether each sample saw a call, even while recording is paused (a call goes on with the screen locked). */
  onCallState?(onCall: boolean): void;
}

/**
 * Keeps the activity log running: starts the front-window helper (restarting it if it dies), feeds its
 * samples to the recorder, and stops recording while the screen is locked or the Mac sleeps.
 */
export class ActivityTracker {
  private helper: WindowHelper | null = null;
  private pausedFor = new Set<string>();
  private stopped = true;
  private restartTimer: NodeJS.Timeout | null = null;
  /** Helper runs in a row that ended before printing a sample; sets the restart delay. */
  private failures = 0;

  /** @param deps The recorder, helper and clock. */
  constructor(private readonly deps: ActivityTrackerDeps) {}

  /** Starts the helper. */
  start(): void {
    this.stopped = false;
    this.launchHelper();
  }

  /** Starts the helper and arranges a restart if it stops while the tracker is running. */
  private launchHelper(): void {
    let gotSample = false;
    const helper = this.deps.startHelper(
      (sample) => {
        // A replaced or stopped helper can still print a line or two before it exits; drop them.
        if (this.helper !== helper || this.stopped) {
          return;
        }
        gotSample = true;
        this.failures = 0;
        this.onSample(sample);
      },
      (reason) => {
        if (this.helper !== helper || this.stopped) {
          return;
        }
        this.helper = null;
        this.failures = gotSample ? 0 : this.failures + 1;
        const delay = Math.min(RESTART_DELAY_MS * 2 ** Math.max(0, this.failures - 1), MAX_RESTART_DELAY_MS);
        console.error(`Time Center: the front-window helper stopped (${reason}); restarting in ${delay / 1000} s.`);
        this.deps.recorder.pause(this.deps.now());
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.stopped) {
            this.launchHelper();
          }
        }, delay);
      },
    );
    this.helper = helper;
  }

  /**
   * Passes on the call state, then records the sample unless the screen is locked or the Mac is asleep.
   * @param sample What was in front.
   */
  private onSample(sample: WindowSample): void {
    this.deps.onCallState?.(sample.onCall === true);
    if (this.pausedFor.size > 0) {
      return;
    }
    this.deps.recorder.record(sample, this.deps.now(), this.deps.getIdleMs());
  }

  /** Replaces the running helper with a new one, so a changed ignored-apps list takes effect. */
  restart(): void {
    if (this.stopped) {
      return;
    }
    const old = this.helper;
    this.helper = null;
    old?.stop();
    this.deps.recorder.pause(this.deps.now());
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.failures = 0;
    this.launchHelper();
  }

  /**
   * Stops recording until resume() is called with the same reason, e.g. "locked" or "asleep".
   * @param reason Why.
   */
  pause(reason: string): void {
    this.pausedFor.add(reason);
    this.deps.recorder.pause(this.deps.now());
  }

  /**
   * Lifts one reason for pausing; recording carries on when none are left.
   * @param reason The reason passed to pause().
   */
  resume(reason: string): void {
    this.pausedFor.delete(reason);
  }

  /**
   * What is being recorded right now, so screenshots can skip away time and Edge.
   * @returns The open stretch, or null while paused or between stretches.
   */
  current(): { id: number; kind: SegmentKind } | null {
    return this.pausedFor.size > 0 ? null : this.deps.recorder.current();
  }

  /** Stops the helper and closes the open stretch, for quit. */
  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const helper = this.helper;
    this.helper = null;
    helper?.stop();
    this.deps.recorder.pause(this.deps.now());
  }
}
