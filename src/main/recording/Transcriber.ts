import type { TranscriptLine } from "../../shared/ipc";
import type { AudioChunk } from "./recorderProcess";
import type { RecordingStore } from "./RecordingStore";
import type { WhisperSegment } from "./whisper";

/** How long to wait before trying again when whisper or its model is missing. */
export const RETRY_MS = 5 * 60_000;

/** What the transcriber needs, injected for tests. */
export interface TranscriberDeps {
  store: Pick<RecordingStore, "insertLines">;
  /** Finds whisper-cli and the speech model (downloading the model if needed); throws a plain-words problem. */
  prepare(): Promise<{ whisper: string; model: string }>;
  /** Runs whisper on one WAV at low priority and returns what it heard, offsets in ms from the file's start. */
  run(whisper: string, model: string, wav: string): Promise<WhisperSegment[]>;
  /** Deletes a chunk whisper has finished with. */
  remove(wav: string): Promise<void>;
  /** Sets a chunk aside that whisper couldn't read, so it isn't tried again and again. */
  setAside(wav: string): Promise<void>;
  /** Ends a whisper run in progress, for quit; its chunk stays on disk for the next start. */
  cancel(): void;
  /** Called when the transcript of a call grows, or the problem changes. */
  onChange(): void;
  /** Called with a chunk's stored lines (and their ids) while its audio is still on disk, to tell voices apart. */
  onLines(recordingId: number, chunk: AudioChunk, lines: { id: number; start: number; end: number; speakerId: null }[]): Promise<void>;
  log(message: string, error?: unknown): void;
}

/** One chunk waiting its turn. */
interface Job {
  recordingId: number;
  chunk: AudioChunk;
}

/**
 * Turns the recorder's chunks into transcript lines, one whisper run at a time, oldest first, as the call
 * goes. A chunk stays on disk until it has been read, so a quit mid-call loses nothing: the next start
 * queues what was left (see recoverRecordings).
 */
export class Transcriber {
  private readonly queue: Job[] = [];
  private running = false;
  private problem: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  /** @param deps whisper, the store and the file system. */
  constructor(private readonly deps: TranscriberDeps) {}

  /**
   * Queues a chunk and starts working if idle.
   * @param recordingId The call it belongs to.
   * @param chunk The audio.
   */
  add(recordingId: number, chunk: AudioChunk): void {
    if (this.queue.some((job) => job.chunk.wav === chunk.wav)) {
      return;
    }
    this.queue.push({ recordingId, chunk });
    this.deps.onChange();
    void this.drain();
  }

  /** Finds whisper and the model now (downloading the model if needed), so a problem shows before the first call. */
  async prepareAhead(): Promise<void> {
    try {
      await this.deps.prepare();
      this.setProblem(null);
    } catch (error) {
      this.setProblem(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * How many chunks of a call are still waiting.
   * @param recordingId The call.
   * @returns The count, the one being read included.
   */
  waiting(recordingId: number): number {
    return this.queue.filter((job) => job.recordingId === recordingId).length;
  }

  /**
   * What is stopping transcription, in plain words.
   * @returns The problem, or null when it can run.
   */
  currentProblem(): string | null {
    return this.problem;
  }

  /** Stops taking new work, for quit. The chunk being read is finished by whisper or picked up next start. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.deps.cancel();
  }

  /** Works through the queue until it is empty, or whisper can't run (then waits for the retry timer). */
  private async drain(): Promise<void> {
    // While a retry is pending, new chunks only queue: re-trying on each one would restart a failed
    // 1.6 GB model download every few seconds through the call.
    if (this.running || this.stopped || this.retryTimer) {
      return;
    }
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        let tools: { whisper: string; model: string };
        try {
          tools = await this.deps.prepare();
        } catch (error) {
          this.setProblem(error instanceof Error ? error.message : String(error));
          this.retryLater();
          return;
        }
        this.setProblem(null);
        await this.transcribe(this.queue[0], tools);
        this.queue.shift();
        this.deps.onChange();
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Reads one chunk and stores its lines. A chunk whisper fails on is set aside; one whose lines couldn't be
   * stored (e.g. the app is quitting) stays where it is, to be read again on the next start.
   * @param job The chunk.
   * @param tools whisper-cli and the model.
   */
  private async transcribe(job: Job, tools: { whisper: string; model: string }): Promise<void> {
    let segments: WhisperSegment[];
    try {
      segments = await this.deps.run(tools.whisper, tools.model, job.chunk.wav);
    } catch (error) {
      if (!this.stopped) {
        this.deps.log(`Time Center: whisper couldn't read ${job.chunk.wav}`, error);
        await this.deps.setAside(job.chunk.wav).catch(() => {});
      }
      return;
    }
    if (this.stopped) {
      return;
    }
    try {
      const lines = toLines(job.chunk, segments);
      const ids = this.deps.store.insertLines(job.recordingId, lines);
      await this.deps.onLines(
        job.recordingId,
        job.chunk,
        lines.map((line, index) => ({ id: ids[index], start: line.start, end: line.end, speakerId: null })),
      );
      await this.deps.remove(job.chunk.wav);
    } catch (error) {
      this.deps.log(`Time Center: couldn't store the transcript of ${job.chunk.wav}`, error);
    }
  }

  /**
   * Records what is stopping transcription, telling the screen only when it changes.
   * @param problem The problem, or null.
   */
  private setProblem(problem: string | null): void {
    if (problem !== this.problem) {
      this.problem = problem;
      this.deps.onChange();
    }
  }

  /** Tries the queue again in a few minutes (whisper installed, model downloaded, network back). */
  private retryLater(): void {
    if (this.retryTimer || this.stopped) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drain();
    }, RETRY_MS);
  }
}

/**
 * Turns whisper's segments into transcript lines at real times, dropping the non-speech whisper marks
 * ("[BLANK_AUDIO]", "(music)") and empty ones.
 * @param chunk The chunk they came from.
 * @param segments What whisper heard, offsets from the chunk's start.
 * @returns The lines.
 */
export function toLines(chunk: AudioChunk, segments: WhisperSegment[]): TranscriptLine[] {
  return segments
    .map((segment) => ({ ...segment, text: segment.text.trim() }))
    .filter((segment) => segment.text !== "" && !/^[[(].*[\])]$/.test(segment.text))
    .map((segment) => ({
      side: chunk.side,
      start: chunk.t0 + segment.from,
      end: chunk.t0 + segment.to,
      text: segment.text,
      speakerId: null,
    }));
}
