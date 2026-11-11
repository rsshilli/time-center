import { RecordingController, START_AFTER_MS, STOP_AFTER_MS } from "../../src/main/recording/RecordingController";
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
  const samples = (onCall: boolean, ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 3_000) {
      controller.callSample(onCall);
      clock.now += 3_000;
    }
  };
  return { controller, log, clock, recorders, samples, solo };
}

describe("RecordingController", () => {
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

  it("should not restart a recorder that failed until the call is over", () => {
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
