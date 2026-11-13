import {
  appFamily,
  EXIT_WAIT_MS,
  RecordingController,
  RETRY_AFTER_MS,
  START_AFTER_MS,
  STOP_AFTER_MS,
  SWITCH_AFTER_MS,
} from "../../src/main/recording/RecordingController";
import type { AudioChunk, RecorderEvents } from "../../src/main/recording/recorderProcess";

/**
 * A controller on fakes: a clock the test moves, a store that logs, and a recorder the test drives.
 * @returns The controller, the log, the recorder's events and the clock.
 */
function setUp() {
  const log: string[] = [];
  const clock = { now: 1_000_000 };
  /** Your own calendar block runs until this time. */
  const solo = { until: 0 };
  const recorders: { folder: string; events: RecorderEvents; stopped: boolean }[] = [];
  let nextId = 1;
  const controller = new RecordingController({
    store: {
      insertRecording: (start, folder) => {
        log.push(`insert ${start} ${folder.split("/").slice(-3, -1).join("/")}`);
        return nextId++;
      },
      markNoMic: (id) => log.push(`no mic ${id}`),
      finishRecording: (id, end, error) => log.push(`finish ${id} ${end}${error ? ` ${error}` : ""}`),
    },
    startRecorder: (folder, events) => {
      const recorder = { folder, events, stopped: false };
      recorders.push(recorder);
      return { stop: () => (recorder.stopped = true) };
    },
    transcribe: (id, chunk: AudioChunk) => log.push(`transcribe ${id} ${chunk.side}`),
    onFinished: (id) => log.push(`finished ${id}`),
    recordingsDir: "/data/recordings",
    onChange: () => log.push("changed"),
    isSoloTime: (now) => now < solo.until,
    now: () => clock.now,
  });
  /**
   * Feeds samples every 3 s for a while.
   * @param onCall The call state of each.
   * @param ms How long.
   */
  const samples = (onCall: boolean, ms: number, callApps: string[] = []) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 3_000) {
      controller.callSample(onCall, callApps);
      clock.now += 3_000;
    }
  };
  return { controller, log, clock, recorders, samples, solo };
}

describe("RecordingController", () => {
  it("should start a new recording when another app takes the microphone for a different call", () => {
    const { controller, log, clock, recorders, samples } = setUp();
    samples(true, 60_000, ["us.zoom.xos"]);
    // Zoom still holds the microphone for a moment after you join Meet in Chrome.
    samples(true, 6_000, ["Google Chrome Helper", "us.zoom.xos"]);
    samples(true, SWITCH_AFTER_MS, ["Google Chrome Helper"]);
    // Chrome came on at 1,060,000; the first 3-second sample at least SWITCH_AFTER_MS later splits the call.
    const switchedAt = 1_060_000 + Math.ceil(SWITCH_AFTER_MS / 3_000) * 3_000;
    expect(log).toContain(`finish 1 ${switchedAt}`);
    expect(recorders[0].stopped).toBe(true);
    // The new recorder waits for the old one to exit, so the two never capture at once.
    expect(recorders).toHaveLength(1);
    recorders[0].events.onExit(null);
    const restartAt = clock.now;
    samples(true, 3_000, ["Google Chrome Helper"]);
    expect(recorders).toHaveLength(2);
    expect(controller.isRecording()).toBe(true);
    expect(log.filter((line) => line.startsWith("insert")).map((line) => Number(line.split(" ")[1]))).toEqual([1_006_000, restartAt]);
    // Back to Zoom for the next meeting: a third recording.
    samples(true, SWITCH_AFTER_MS + 3_000, ["us.zoom.xos"]);
    recorders[1].events.onExit(null);
    samples(true, 3_000, ["us.zoom.xos"]);
    expect(recorders).toHaveLength(3);
  });

  it("should start the next recorder anyway when the last one hasn't exited after a while", () => {
    const { recorders, samples } = setUp();
    samples(true, 30_000, ["us.zoom.xos"]);
    samples(true, SWITCH_AFTER_MS + 3_000, ["Google Chrome Helper"]);
    expect(recorders).toHaveLength(1);
    samples(true, EXIT_WAIT_MS, ["Google Chrome Helper"]);
    expect(recorders).toHaveLength(2);
  });

  it("should try a recorder that stopped by itself again a minute later, while the call goes on", () => {
    const { controller, log, recorders, samples } = setUp();
    samples(true, 9_000, ["Google Chrome Helper"]);
    recorders[0].events.onExit("Recording stopped: Failed during stream due to application connection being interrupted");
    expect(log.some((line) => line.startsWith("finish 1") && line.includes("interrupted"))).toBe(true);
    samples(true, RETRY_AFTER_MS - 3_000, ["Google Chrome Helper"]);
    expect(recorders).toHaveLength(1);
    samples(true, 6_000, ["Google Chrome Helper"]);
    expect(recorders).toHaveLength(2);
    expect(controller.isRecording()).toBe(true);
  });

  it("should keep one recording when another app holds the microphone only briefly, or it's the same app's helper", () => {
    const { recorders, samples } = setUp();
    samples(true, 30_000, ["us.zoom.xos"]);
    samples(true, SWITCH_AFTER_MS - 3_000, ["com.google.Chrome", "us.zoom.xos"]);
    samples(true, 30_000, ["us.zoom.xos"]);
    samples(true, 60_000, ["us.zoom.CptHost", "us.zoom.xos"]);
    expect(recorders).toHaveLength(1);
  });

  it("should never split when the helper doesn't say which apps are on the call", () => {
    const { recorders, samples } = setUp();
    samples(true, 120_000);
    expect(recorders).toHaveLength(1);
  });

  it("should not record during time blocked out for just you, and start once that block is over", () => {
    const { controller, clock, recorders, samples, solo } = setUp();
    solo.until = clock.now + 60_000;
    samples(true, 57_000);
    expect(recorders).toHaveLength(0);
    samples(true, 6_000);
    expect(recorders).toHaveLength(1);
    expect(controller.isRecording()).toBe(true);
  });

  it("should start recording once a call has lasted a few seconds, not on a single blip", () => {
    const { controller, recorders, samples } = setUp();
    samples(true, 3_000);
    samples(false, 3_000);
    expect(recorders).toHaveLength(0);
    samples(true, START_AFTER_MS + 3_000);
    expect(recorders).toHaveLength(1);
    expect(controller.isRecording()).toBe(true);
    expect(recorders[0].folder).toMatch(/^\/data\/recordings\/\.work\/\d{4}-\d{2}-\d{2}\/\d{6}[+-]\d{4}$/);
  });

  it("should hand the call over for naming once the recorder has exited, asked to or not", () => {
    const { controller, log, recorders, samples } = setUp();
    samples(true, 9_000);
    controller.stop();
    expect(log).not.toContain("finished 1");
    recorders[0].events.onExit(null);
    expect(log).toContain("finished 1");
  });

  it("should keep one recording through a short gap and stop half a minute after the call ends, at its real end", () => {
    const { controller, log, clock, recorders, samples } = setUp();
    samples(true, 9_000);
    samples(false, 12_000);
    samples(true, 6_000);
    expect(recorders).toHaveLength(1);
    const lastCall = clock.now - 3_000;
    samples(false, STOP_AFTER_MS + 3_000);
    expect(controller.isRecording()).toBe(false);
    expect(recorders[0].stopped).toBe(true);
    expect(log).toContain(`finish 1 ${lastCall + 3_000}`);
  });

  it("should stop when samples stop coming altogether", () => {
    const { controller, clock, samples } = setUp();
    samples(true, 9_000);
    clock.now += STOP_AFTER_MS + 1;
    controller.tick();
    expect(controller.isRecording()).toBe(false);
  });

  it("should send every chunk to the transcriber, including the last one flushed after stopping", () => {
    const { controller, log, recorders, samples } = setUp();
    samples(true, 9_000);
    recorders[0].events.onChunk({ wav: "/a.wav", side: "them", t0: 1 });
    controller.stop();
    recorders[0].events.onChunk({ wav: "/b.wav", side: "me", t0: 2 });
    expect(log.filter((line) => line.startsWith("transcribe"))).toEqual(["transcribe 1 them", "transcribe 1 me"]);
  });

  it("should note a refused microphone", () => {
    const { log, recorders, samples } = setUp();
    samples(true, 9_000);
    recorders[0].events.onReady(false);
    expect(log).toContain("no mic 1");
  });

  it("should not restart a recorder missing its permission until the call is over", () => {
    const { controller, log, recorders, samples } = setUp();
    samples(true, 9_000);
    recorders[0].events.onExit("macOS hasn't allowed Time Center to record");
    expect(controller.isRecording()).toBe(false);
    expect(log.some((line) => line.startsWith("finish 1") && line.includes("hasn't allowed"))).toBe(true);
    samples(true, 30_000);
    expect(recorders).toHaveLength(1);
    samples(false, STOP_AFTER_MS + 3_000);
    samples(true, 9_000);
    expect(recorders).toHaveLength(2);
  });
});

describe("appFamily", () => {
  it("should count an app's helper processes as the app", () => {
    expect(appFamily("us.zoom.CptHost")).toBe(appFamily("us.zoom.xos"));
    expect(appFamily("Google Chrome Helper (Renderer)")).toBe("Google Chrome");
    expect(appFamily("com.microsoft.teams2")).toBe("com.microsoft");
    expect(appFamily("coreaudiod")).toBe("coreaudiod");
  });
});
