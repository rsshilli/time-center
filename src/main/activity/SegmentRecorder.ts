import type { SegmentKind } from "../../shared/ipc";
import type { ActivityStore } from "./ActivityStore";
import { domainOf, projectOf } from "./classify";

/** One report from the front-window helper. */
export interface WindowSample {
  app: string | null;
  bundleId: string | null;
  title: string | null;
  url: string | null;
  /** True for an ignored app (Edge): only its name was read, and none of it is stored. */
  ignored: boolean;
  /** True while an app (Zoom, Chrome for Meet, Teams…) is using the microphone, i.e. you're on a call. */
  onCall?: boolean;
  /** The apps using the microphone for the call (bundle ids, or a process name), so a new call starts a new recording. */
  callApps?: string[];
}

/** Counted as away after this long without keyboard or mouse input (user's pick: 5 minutes). */
export const IDLE_AFTER_MS = 5 * 60_000;

/**
 * Samples arrive every 3 seconds. A longer silence means the Mac slept or the helper stalled, so the
 * stretch is not stretched across it.
 */
export const MAX_GAP_MS = 15_000;

/** The stretch being extended right now. */
interface OpenSegment {
  id: number;
  key: string;
  kind: SegmentKind;
  startedAt: number;
  endedAt: number;
}

/**
 * Turns the helper's samples into stretches of time. A sample with the same window as the open stretch
 * extends it; a different window closes it and opens a new one. After five minutes without input the
 * time since the last input is moved into an "away" stretch — except on a call: listening and talking
 * aren't typing, so time with a call going never counts as away. Lock and sleep close the open stretch.
 */
export class SegmentRecorder {
  private open: OpenSegment | null = null;
  /** When a sample last said a call was going; away time can't start before it. */
  private lastCallAt = Number.NEGATIVE_INFINITY;
  /** The end of the last stretch written, including by an earlier run of the app. Nothing starts before it. */
  private floor: number;

  /** @param store Where stretches are written. */
  constructor(private readonly store: Pick<ActivityStore, "insertSegment" | "setSegmentEnd" | "getLatestSegmentEnd">) {
    this.floor = store.getLatestSegmentEnd() ?? Number.NEGATIVE_INFINITY;
  }

  /**
   * Records one sample.
   * @param sample What was in front.
   * @param at When it was read.
   * @param idleMs How long since the last keyboard or mouse input.
   */
  record(sample: WindowSample, at: number, idleMs: number): void {
    if (sample.onCall) {
      this.lastCallAt = at;
    }
    // Away is counted from the later of the last input and the end of the last call.
    const awayMs = Math.min(idleMs, at - this.lastCallAt);
    if (awayMs >= IDLE_AFTER_MS) {
      this.recordIdle(at, awayMs);
      return;
    }
    const fields = SegmentRecorder.describe(sample);
    // A call starting or ending starts a new stretch, so each stretch is wholly on a call or not.
    const key = [fields.kind, fields.bundleId, fields.title, fields.url, fields.onCall].join("\u0001");
    const open = this.open;
    if (open && this.isContiguous(at)) {
      this.extend(open, at);
      if (open.key === key) {
        return;
      }
    }
    this.startSegment(key, { ...fields, startedAt: at, endedAt: at });
  }

  /**
   * Records a sample taken while away: the open stretch is cut back to the last input, and the time
   * since then becomes (or extends) an away stretch.
   * @param at When the sample was read.
   * @param idleMs How long since the last input.
   */
  private recordIdle(at: number, idleMs: number): void {
    const open = this.open;
    const contiguous = open !== null && this.isContiguous(at);
    if (open && contiguous && open.kind === "idle") {
      this.extend(open, at);
      return;
    }
    let startedAt = at - idleMs;
    if (open && contiguous) {
      // The stretch really ended at the last input; it can't end before it began.
      const cut = Math.max(open.startedAt, startedAt);
      this.store.setSegmentEnd(open.id, cut);
      startedAt = cut;
    } else {
      // Don't reach back over time already recorded, by this run or an earlier one.
      startedAt = Math.min(at, Math.max(startedAt, this.floor));
    }
    this.startSegment("idle", {
      kind: "idle",
      app: null,
      bundleId: null,
      title: null,
      url: null,
      domain: null,
      project: null,
      startedAt,
      endedAt: at,
    });
  }

  /**
   * Works out what is stored for a sample. Ignored apps keep nothing, not even their name.
   * @param sample The sample.
   * @returns The stored fields.
   */
  private static describe(sample: WindowSample) {
    if (sample.ignored) {
      return { kind: "untracked" as const, app: null, bundleId: null, title: null, url: null, domain: null, project: null, onCall: false };
    }
    return {
      kind: "active" as const,
      app: sample.app,
      bundleId: sample.bundleId,
      title: sample.title,
      url: sample.url,
      domain: domainOf(sample.url),
      project: projectOf(sample.bundleId, sample.title),
      onCall: sample.onCall === true,
    };
  }

  /**
   * Says whether a sample follows on from the open stretch without a sleep-sized gap.
   * @param at The sample time.
   * @returns True when it does.
   */
  private isContiguous(at: number): boolean {
    return this.open !== null && at >= this.open.endedAt && at - this.open.endedAt <= MAX_GAP_MS;
  }

  /**
   * Moves the open stretch's end forward.
   * @param open The open stretch.
   * @param at Its new end.
   */
  private extend(open: OpenSegment, at: number): void {
    this.store.setSegmentEnd(open.id, at);
    open.endedAt = at;
    this.floor = Math.max(this.floor, at);
  }

  /**
   * Stores a new stretch and makes it the open one.
   * @param key What identifies its window.
   * @param segment The stretch.
   */
  private startSegment(key: string, segment: Parameters<ActivityStore["insertSegment"]>[0]): void {
    const id = this.store.insertSegment(segment);
    this.open = { id, key, kind: segment.kind, startedAt: segment.startedAt, endedAt: segment.endedAt };
    this.floor = Math.max(this.floor, segment.endedAt);
  }

  /**
   * Closes the open stretch, for lock, sleep and quit.
   * @param at When it happened.
   */
  pause(at: number): void {
    if (this.open && this.isContiguous(at)) {
      this.extend(this.open, at);
    }
    this.open = null;
  }

  /**
   * The stretch being extended right now, which screenshots are linked to.
   * @returns Its id and kind, or null between stretches.
   */
  current(): { id: number; kind: SegmentKind } | null {
    return this.open ? { id: this.open.id, kind: this.open.kind } : null;
  }
}
