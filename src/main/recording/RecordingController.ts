import { join } from "node:path";
import { localStamp } from "../screenshots/ScreenCapturer";
import type { AudioChunk, RecorderEvents, RecorderHandle } from "./recorderProcess";
import type { RecordingStore } from "./RecordingStore";

/** A call must last this long before recording starts, so a moment of dictation or Siri isn't recorded. */
export const START_AFTER_MS = 5_000;

/**
 * Recording stops once no call has been seen for this long. Covers the mic being let go for a moment
 * (changing headsets, a browser re-asking for it) without cutting one call into two recordings.
 */
export const STOP_AFTER_MS = 30_000;

/**
 * An app that wasn't on the call must hold the microphone this long before it counts as a new call (Zoom, then
 * Meet in Chrome, then Teams) and starts a new recording, so a quick mic check in another app doesn't split one.
 */
export const SWITCH_AFTER_MS = 20_000;

/**
 * After the recorder stops by itself mid-call, try again this long later. On 11/13 the recorder started for a
 * Meet call died after 4 s ("application connection being interrupted") and the call ran on unrecorded for 90 min.
 */
export const RETRY_AFTER_MS = 60_000;

/**
 * How long to wait for the last recorder to exit before starting the next one anyway, should it hang. Two
 * recorders capturing at once is the suspected (not proven) cause of the 11/13 failure above.
 */
export const EXIT_WAIT_MS = 10_000;

/** How the recorder's missing-permission failure begins (native/MeetingRecorder.swift); retrying can't help it. */
const NO_PERMISSION = "macOS hasn't allowed";

/** What the controller needs, injected for tests. */
export interface RecordingControllerDeps {
  store: Pick<RecordingStore, "insertRecording" | "markNoMic" | "finishRecording">;
  /** Starts the Swift recorder writing into a folder. */
  startRecorder(folder: string, events: RecorderEvents): RecorderHandle;
  /** Queues a piece of audio for whisper. */
  transcribe(recordingId: number, chunk: AudioChunk): void;
  /** The recorder has exited and mixed both sides into one file, which can now be named after the meeting. */
  onFinished(recordingId: number): void;
  /** The folder that holds one sub-folder per day of recordings. */
  recordingsDir: string;
  /** Called when recording starts or stops, to redraw the menu-bar dot. */
  onChange(): void;
  /** Whether now is time blocked out for just you, when the microphone in use is dictation rather than a call. */
  isSoloTime(now: number): boolean;
  now(): number;
}

/** The recording in progress. */
interface ActiveRecording {
  id: number;
  handle: RecorderHandle;
  /** The apps that have used the microphone during it. */
  apps: Set<string>;
}

/**
 * Records any call: starts the recorder once some app has been using the microphone for a few seconds (the
 * front-window helper's onCall, every 3 s), and stops it once the call has been over for half a minute.
 * A recorder that fails is tried again a minute later, or, missing a permission, not until that call ends, so it
 * can't spin. A new recorder waits for the last one to exit.
 */
export class RecordingController {
  private active: ActiveRecording | null = null;
  /** When the current run of "on a call" samples began, or null between calls. */
  private callStartedAt: number | null = null;
  private lastCallAt = Number.NEGATIVE_INFINITY;
  /** After the recorder failed during this call, don't start another before this time (Infinity: not this call). */
  private retryAt = Number.NEGATIVE_INFINITY;
  /** The recorder asked to stop that hasn't exited yet, and when it was asked, or null. */
  private exiting: { id: number; since: number } | null = null;
  /** When an app not on the recording's call started using the microphone, or null when none has. */
  private newAppSince: number | null = null;

  /** @param deps The store, recorder, transcriber and clock. */
  constructor(private readonly deps: RecordingControllerDeps) {}

  /**
   * Takes one front-window sample's call state.
   * @param onCall Whether some app other than Krisp or Time Center is using the microphone.
   * @param callApps Which apps are using it. One that wasn't on the recording's call, holding it for
   * SWITCH_AFTER_MS, means you've moved to another call: the recording ends and a new one starts.
   */
  callSample(onCall: boolean, callApps: readonly string[] = []): void {
    const now = this.deps.now();
    if (!onCall) {
      if (!this.active) {
        this.callStartedAt = null;
      }
      this.newAppSince = null;
      this.tick();
      return;
    }
    this.lastCallAt = now;
    this.callStartedAt ??= now;
    if (this.active && this.isNewCall(callApps, now)) {
      this.finish(now);
    }
    // Checked on every sample, so a call still going when your own block ends is recorded from then on.
    if (!this.active && this.mayStart(now) && now - this.callStartedAt >= START_AFTER_MS && !this.deps.isSoloTime(now)) {
      this.start(now, callApps);
    }
  }

  /**
   * Says whether a recorder may start now: no failure is being waited out, and the last recorder has exited.
   * @param now The current time.
   * @returns True when it may.
   */
  private mayStart(now: number): boolean {
    if (now < this.retryAt) {
      return false;
    }
    return this.exiting === null || now - this.exiting.since >= EXIT_WAIT_MS;
  }

  /**
   * Says whether the apps on the microphone show you've moved to another call: one that wasn't on this
   * recording's call has held it for SWITCH_AFTER_MS. Until then it waits; once it goes, the wait starts over.
   * @param callApps The apps using the microphone now.
   * @param now The current time.
   * @returns True when the recording should end so a new one can start.
   */
  private isNewCall(callApps: readonly string[], now: number): boolean {
    const apps = this.active?.apps ?? new Set<string>();
    if (!callApps.some((app) => !apps.has(appFamily(app)))) {
      this.newAppSince = null;
      return false;
    }
    this.newAppSince ??= now;
    if (now - this.newAppSince < SWITCH_AFTER_MS) {
      return false;
    }
    this.newAppSince = null;
    return true;
  }

  /** Stops a recording whose call has been over long enough. Also run on a timer, as samples can stop coming. */
  tick(): void {
    const now = this.deps.now();
    if (now - this.lastCallAt < STOP_AFTER_MS) {
      return;
    }
    this.callStartedAt = null;
    this.retryAt = Number.NEGATIVE_INFINITY;
    if (this.active) {
      // The call ended at the last sample that saw it, not half a minute later when we noticed.
      this.finish(Math.min(now, this.lastCallAt + 3_000));
    }
  }

  /**
   * Whether a call is being recorded now, for the menu-bar dot.
   * @returns True while recording.
   */
  isRecording(): boolean {
    return this.active !== null;
  }

  /** Stops recording for quit or sleep; the recorder finishes its files as it exits. */
  stop(): void {
    if (this.active) {
      this.finish(this.deps.now());
    }
    this.callStartedAt = null;
    this.lastCallAt = Number.NEGATIVE_INFINITY;
    this.retryAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * Starts a recording row and the recorder.
   * @param now The current time.
   * @param callApps The apps on the call, to notice when you move to another one.
   */
  private start(now: number, callApps: readonly string[]): void {
    const stamp = localStamp(now);
    // Working files go in a hidden folder; the recordings folder itself holds only the named calls.
    const folder = join(this.deps.recordingsDir, ".work", stamp.day, `${stamp.time}${stamp.zone}`);
    const id = this.deps.store.insertRecording(now, folder);
    const handle = this.deps.startRecorder(folder, {
      /** Notes a refused microphone, so Today can say only the other side was recorded. */
      onReady: (mic) => {
        if (!mic) {
          this.deps.store.markNoMic(id);
        }
      },
      // A chunk can arrive after stop(): the recorder flushes its last one on the way out.
      onChunk: (chunk) => this.deps.transcribe(id, chunk),
      /**
       * The recorder exited, its one file mixed. If it stopped by itself (not asked to): close the row, keep the
       * reason, and hold off a minute, or until the call ends when a permission is missing.
       */
      onExit: (error) => {
        this.deps.onFinished(id);
        if (this.exiting?.id === id) {
          this.exiting = null;
        }
        if (this.active?.id !== id) {
          return;
        }
        this.active = null;
        if (error !== null) {
          this.retryAt = error.startsWith(NO_PERMISSION) ? Number.POSITIVE_INFINITY : this.deps.now() + RETRY_AFTER_MS;
        }
        this.deps.store.finishRecording(id, this.deps.now(), error);
        this.deps.onChange();
      },
    });
    this.active = { id, handle, apps: new Set(callApps.map(appFamily)) };
    this.deps.onChange();
  }

  /**
   * Ends the recording in progress.
   * @param end When the call ended.
   */
  private finish(end: number): void {
    const active = this.active;
    if (!active) {
      return;
    }
    this.active = null;
    this.exiting = { id: active.id, since: this.deps.now() };
    this.deps.store.finishRecording(active.id, end);
    active.handle.stop();
    this.deps.onChange();
  }
}

/**
 * Names the app behind a process on the microphone, so an app's helper processes count as the app: a bundle id's
 * first two parts ("us.zoom.xos" and "us.zoom.CptHost" are both "us.zoom"), or a process name without " Helper…"
 * ("Google Chrome Helper" is "Google Chrome").
 * @param app A bundle id, or a process name.
 * @returns The app's family.
 */
export function appFamily(app: string): string {
  if (app.includes(" ") || !app.includes(".")) {
    return app.replace(/ Helper.*$/, "");
  }
  return app.split(".").slice(0, 2).join(".").toLowerCase();
}
