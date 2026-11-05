import { ActivityTracker } from "../../src/main/activity/ActivityTracker";
import { SegmentRecorder, type WindowSample } from "../../src/main/activity/SegmentRecorder";
import { parseSample } from "../../src/main/activity/windowHelper";

/** A recorder fake that remembers what it was asked to do. */
function fakeRecorder() {
  const calls: string[] = [];
  const recorder = {
    record: (sample: WindowSample) => calls.push(`record ${sample.app}`),
    pause: () => calls.push("pause"),
    current: () => ({ id: 7, kind: "active" as const }),
  } as unknown as SegmentRecorder;
  return { recorder, calls };
}

describe("ActivityTracker", () => {
  let send: (sample: WindowSample) => void;
  let exit: (reason: string) => void;
  let stops: number;

  /** Builds a tracker on a fake helper that the test drives. */
  const build = (recorder: SegmentRecorder) =>
    new ActivityTracker({
      recorder,
      startHelper: (onSample, onExit) => {
        send = onSample;
        exit = onExit;
        return { stop: () => stops++ };
      },
      getIdleMs: () => 0,
      now: () => 1000,
    });

  beforeEach(() => {
    stops = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should pass samples to the recorder", () => {
    const { recorder, calls } = fakeRecorder();
    build(recorder).start();
    send({ app: "Slack", bundleId: null, title: null, url: null, ignored: false });
    expect(calls).toEqual(["record Slack"]);
  });

  it("should drop samples while paused and report nothing open", () => {
    const { recorder, calls } = fakeRecorder();
    const tracker = build(recorder);
    tracker.start();
    tracker.pause("locked");
    send({ app: "loginwindow", bundleId: null, title: null, url: null, ignored: false });
    expect(calls).toEqual(["pause"]);
    expect(tracker.current()).toBeNull();
  });

  it("should keep paused until every reason is lifted", () => {
    const { recorder, calls } = fakeRecorder();
    const tracker = build(recorder);
    tracker.start();
    tracker.pause("locked");
    tracker.pause("asleep");
    tracker.resume("asleep");
    send({ app: "A", bundleId: null, title: null, url: null, ignored: false });
    tracker.resume("locked");
    send({ app: "B", bundleId: null, title: null, url: null, ignored: false });
    expect(calls).toEqual(["pause", "pause", "record B"]);
  });

  it("should restart the helper after it stops unexpectedly", () => {
    const { recorder } = fakeRecorder();
    let starts = 0;
    const tracker = new ActivityTracker({
      recorder,
      startHelper: (_onSample, onExit) => {
        starts++;
        exit = onExit;
        return { stop: () => stops++ };
      },
      getIdleMs: () => 0,
      now: () => 0,
    });
    tracker.start();
    exit("crashed");
    vi.advanceTimersByTime(10_000);
    expect(starts).toBe(2);
  });

  it("should not restart the helper after stop()", () => {
    const { recorder } = fakeRecorder();
    let starts = 0;
    const tracker = new ActivityTracker({
      recorder,
      startHelper: (_onSample, onExit) => {
        starts++;
        exit = onExit;
        return { stop: () => onExit("stopped") };
      },
      getIdleMs: () => 0,
      now: () => 0,
    });
    tracker.start();
    tracker.stop();
    vi.advanceTimersByTime(60_000);
    expect(starts).toBe(1);
  });

  it("should drop a sample the helper printed just before quit, after the database may be closed", () => {
    const { recorder, calls } = fakeRecorder();
    const tracker = build(recorder);
    tracker.start();
    tracker.stop();
    send({ app: "Late", bundleId: null, title: null, url: null, ignored: false });
    expect(calls).toEqual(["pause"]);
  });

  it("should wait longer after each start that fails before printing anything", () => {
    const { recorder } = fakeRecorder();
    let starts = 0;
    const tracker = new ActivityTracker({
      recorder,
      startHelper: (_onSample, onExit) => {
        starts++;
        exit = onExit;
        return { stop: () => stops++ };
      },
      getIdleMs: () => 0,
      now: () => 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    tracker.start();
    exit("spawn ENOENT");
    vi.advanceTimersByTime(10_000);
    exit("spawn ENOENT");
    vi.advanceTimersByTime(10_000);
    expect(starts).toBe(2);
    vi.advanceTimersByTime(10_000);
    expect(starts).toBe(3);
    tracker.stop();
    vi.restoreAllMocks();
  });

  it("should swap in a new helper on restart() and ignore the old one's last words", () => {
    const { recorder, calls } = fakeRecorder();
    const senders: ((sample: WindowSample) => void)[] = [];
    const exits: ((reason: string) => void)[] = [];
    const tracker = new ActivityTracker({
      recorder,
      startHelper: (onSample, onExit) => {
        senders.push(onSample);
        exits.push(onExit);
        return { stop: () => stops++ };
      },
      getIdleMs: () => 0,
      now: () => 0,
    });
    tracker.start();
    tracker.restart();
    senders[0]({ app: "Old", bundleId: null, title: null, url: null, ignored: false });
    exits[0]("exited with code 0");
    senders[1]({ app: "New", bundleId: null, title: null, url: null, ignored: false });
    vi.advanceTimersByTime(60_000);
    expect(senders).toHaveLength(2);
    expect(stops).toBe(1);
    expect(calls).toEqual(["pause", "record New"]);
  });
});

describe("parseSample", () => {
  it("should read a helper line", () => {
    expect(parseSample('{"app":"Google Chrome","bundleId":"com.google.Chrome","title":"PR","url":"https://x","ignored":false}')).toEqual({
      app: "Google Chrome",
      bundleId: "com.google.Chrome",
      title: "PR",
      url: "https://x",
      ignored: false,
    });
  });

  it("should turn missing fields into null", () => {
    expect(parseSample('{"app":"Microsoft Edge","ignored":true}')).toEqual({
      app: "Microsoft Edge",
      bundleId: null,
      title: null,
      url: null,
      ignored: true,
    });
  });

  it("should drop a malformed line", () => {
    expect(parseSample("not json")).toBeNull();
  });
});
