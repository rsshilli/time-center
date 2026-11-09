import type { TranscriptLine } from "../../src/shared/ipc";
import { RETRY_MS, Transcriber, toLines } from "../../src/main/recording/Transcriber";
import type { WhisperSegment } from "../../src/main/recording/whisper";

/**
 * A transcriber on fakes.
 * @param run What "whisper" does with each file.
 * @param prepare Whether whisper and the model can be found.
 * @returns The transcriber and what it did.
 */
function setUp(
  run: (wav: string) => Promise<WhisperSegment[]>,
  prepare: () => Promise<{ whisper: string; model: string }> = async () => ({ whisper: "w", model: "m" }),
  insertLines: (id: number, lines: TranscriptLine[]) => void = () => {},
) {
  const stored: { id: number; lines: TranscriptLine[] }[] = [];
  const removed: string[] = [];
  const setAside: string[] = [];
  const transcriber = new Transcriber({
    store: {
      insertLines: (id, lines) => {
        insertLines(id, lines);
        stored.push({ id, lines });
      },
    },
    prepare,
    run: (_whisper, _model, wav) => run(wav),
    remove: async (wav) => {
      removed.push(wav);
    },
    setAside: async (wav) => {
      setAside.push(wav);
    },
    cancel: () => {},
    onChange: () => {},
    log: () => {},
  });
  return { transcriber, stored, removed, setAside };
}

/** Lets queued promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Transcriber", () => {
  it("should read chunks one at a time in order, store their lines and delete them", async () => {
    let running = 0;
    let most = 0;
    const { transcriber, stored, removed } = setUp(async (wav) => {
      running++;
      most = Math.max(most, running);
      await settle();
      running--;
      return [{ from: 0, to: 1000, text: ` said in ${wav}` }];
    });
    transcriber.add(1, { wav: "/a.wav", side: "me", t0: 100 });
    transcriber.add(1, { wav: "/b.wav", side: "them", t0: 200 });
    transcriber.add(1, { wav: "/a.wav", side: "me", t0: 100 });
    expect(transcriber.waiting(1)).toBe(2);
    await vi.waitFor(() => expect(removed).toEqual(["/a.wav", "/b.wav"]));
    expect(most).toBe(1);
    expect(stored.map((entry) => entry.lines[0].text)).toEqual(["said in /a.wav", "said in /b.wav"]);
    expect(transcriber.waiting(1)).toBe(0);
  });

  it("should set aside a chunk whisper fails on and carry on with the next", async () => {
    const { transcriber, stored, setAside } = setUp(async (wav) => {
      if (wav === "/bad.wav") {
        throw new Error("exit 1");
      }
      return [{ from: 0, to: 500, text: "fine" }];
    });
    transcriber.add(2, { wav: "/bad.wav", side: "me", t0: 0 });
    transcriber.add(2, { wav: "/good.wav", side: "me", t0: 0 });
    await vi.waitFor(() => expect(stored).toHaveLength(1));
    expect(setAside).toEqual(["/bad.wav"]);
  });

  it("should leave a chunk in place, not set it aside, when its lines can't be stored", async () => {
    const { transcriber, removed, setAside } = setUp(
      async () => [{ from: 0, to: 500, text: "hi" }],
      undefined,
      () => {
        throw new Error("database is closed");
      },
    );
    transcriber.add(4, { wav: "/a.wav", side: "me", t0: 0 });
    await vi.waitFor(() => expect(transcriber.waiting(4)).toBe(0));
    expect(removed).toEqual([]);
    expect(setAside).toEqual([]);
  });

  it("should not look for whisper again on every new chunk while a retry is pending", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const { transcriber } = setUp(
        async () => [],
        async () => {
          attempts++;
          throw new Error("Couldn't download the speech model");
        },
      );
      transcriber.add(5, { wav: "/a.wav", side: "me", t0: 0 });
      await vi.advanceTimersByTimeAsync(0);
      transcriber.add(5, { wav: "/b.wav", side: "me", t0: 1 });
      transcriber.add(5, { wav: "/c.wav", side: "me", t0: 2 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(attempts).toBe(1);
      expect(transcriber.waiting(5)).toBe(3);
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should keep the chunks and say why when whisper isn't installed, then try again later", async () => {
    vi.useFakeTimers();
    try {
      let installed = false;
      const { transcriber, stored } = setUp(
        async () => [{ from: 0, to: 500, text: "hi" }],
        async () => {
          if (!installed) {
            throw new Error("whisper.cpp isn't installed");
          }
          return { whisper: "w", model: "m" };
        },
      );
      transcriber.add(3, { wav: "/a.wav", side: "them", t0: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(transcriber.currentProblem()).toMatch(/isn't installed/);
      expect(transcriber.waiting(3)).toBe(1);
      installed = true;
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      expect(stored).toHaveLength(1);
      expect(transcriber.currentProblem()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("toLines", () => {
  it("should place lines at real times and drop whisper's non-speech marks", () => {
    const lines = toLines({ wav: "/x.wav", side: "them", t0: 10_000 }, [
      { from: 0, to: 2000, text: " Hello there." },
      { from: 2000, to: 3000, text: " [BLANK_AUDIO]" },
      { from: 3000, to: 4000, text: " (music)" },
      { from: 4000, to: 4500, text: "  " },
    ]);
    expect(lines).toEqual([{ side: "them", start: 10_000, end: 12_000, text: "Hello there." }]);
  });
});
