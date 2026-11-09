import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingStore } from "../../src/main/recording/RecordingStore";
import {
  INTERRUPTED,
  cleanUpRecordings,
  countUnreadChunks,
  recoverRecordings,
} from "../../src/main/recording/recordingFiles";
import { buildRecordingsReport } from "../../src/main/recording/recordingIpc";
import type { CalendarEvent } from "../../src/main/calendar/meetingLinks";
import type { AudioChunk } from "../../src/main/recording/recorderProcess";
import { Store } from "../../src/main/store/Store";

const NOON = new Date(2026, 10, 6, 12).getTime();
const MIN = 60_000;

describe("RecordingStore", () => {
  let store: Store;
  let recordings: RecordingStore;
  let dir: string;

  beforeEach(() => {
    store = new Store(":memory:");
    recordings = new RecordingStore(store.db);
    dir = mkdtempSync(join(tmpdir(), "tc-recordings-"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("should keep a call and its transcript in the order it was said", () => {
    const id = recordings.insertRecording(NOON, "/r/1");
    recordings.insertLines(id, [
      { side: "them", start: NOON + 5_000, end: NOON + 6_000, text: "Second" },
      { side: "me", start: NOON + 1_000, end: NOON + 2_000, text: "First" },
    ]);
    recordings.finishRecording(id, NOON + 10 * MIN);
    recordings.finishRecording(id, NOON + 99 * MIN, "ignored: already finished");
    expect(recordings.getRecording(id)).toEqual(
      expect.objectContaining({ start: NOON, end: NOON + 10 * MIN, mic: true, error: null, audioDeleted: false }),
    );
    expect(recordings.listLines(id).map((line) => line.text)).toEqual(["First", "Second"]);
  });

  it("should list a call still recording on its day, and name it after the meeting it overlapped most", () => {
    recordings.insertRecording(NOON, "/r/1");
    const meetings = [
      { title: "Stand-up", start: NOON - 30 * MIN, end: NOON + 2 * MIN, response: "accepted" },
      { title: "1-1", start: NOON, end: NOON + 30 * MIN, response: "accepted" },
      { title: "Declined", start: NOON, end: NOON + 60 * MIN, response: "declined" },
    ] as CalendarEvent[];
    const report = buildRecordingsReport(
      {
        store: recordings,
        transcriber: { waiting: () => 2, currentProblem: () => null },
        listMeetings: () => meetings,
        showInFinder: () => {},
        countUnread: () => 0,
        now: () => NOON + 20 * MIN,
      },
      NOON,
    );
    expect(report.recordings).toEqual([
      expect.objectContaining({ end: null, meetingTitle: "1-1", waitingChunks: 2, audioKept: true }),
    ]);
  });

  it("should close a call the app quit during and queue the chunks whisper hadn't read", async () => {
    const folder = join(dir, "2026-11-06", "120000-0500");
    mkdirSync(join(folder, "chunks"), { recursive: true });
    writeFileSync(join(folder, "me.m4a"), "x");
    writeFileSync(join(folder, "chunks", "them-1794008494074-1.wav"), "x");
    writeFileSync(join(folder, "chunks", "me-1794008490283-2.wav.failed"), "x");
    const id = recordings.insertRecording(NOON, folder);
    const queued: AudioChunk[] = [];
    await recoverRecordings(recordings, { add: (_id, chunk) => queued.push(chunk) });
    const recording = recordings.getRecording(id)!;
    expect(recording.end).toBeGreaterThan(NOON);
    expect(recording.error).toBe(INTERRUPTED);
    expect(queued.map((chunk) => chunk.side)).toEqual(["them"]);
  });

  it("should delete the audio of calls past 30 days but keep their transcripts", async () => {
    const oldFolder = join(dir, "old");
    const newFolder = join(dir, "new");
    mkdirSync(oldFolder);
    mkdirSync(newFolder);
    const old = recordings.insertRecording(NOON - 31 * 24 * 60 * MIN, oldFolder);
    recordings.finishRecording(old, NOON - 31 * 24 * 60 * MIN + MIN);
    recordings.insertLines(old, [{ side: "me", start: 1, end: 2, text: "kept" }]);
    const recent = recordings.insertRecording(NOON - MIN, newFolder);
    recordings.finishRecording(recent, NOON);
    expect(await cleanUpRecordings(recordings, NOON)).toBe(1);
    expect(existsSync(oldFolder)).toBe(false);
    expect(existsSync(newFolder)).toBe(true);
    expect(recordings.getRecording(old)!.audioDeleted).toBe(true);
    expect(recordings.listLines(old)).toHaveLength(1);
  });

  it("should keep an old call's audio while chunks of it still wait for whisper", async () => {
    const folder = join(dir, "waiting");
    mkdirSync(join(folder, "chunks"), { recursive: true });
    writeFileSync(join(folder, "chunks", "me-1-1.wav"), "x");
    writeFileSync(join(folder, "chunks", "me-1-2.wav.failed"), "x");
    const id = recordings.insertRecording(NOON - 40 * 24 * 60 * MIN, folder);
    recordings.finishRecording(id, NOON - 40 * 24 * 60 * MIN + MIN);
    expect(await cleanUpRecordings(recordings, NOON)).toBe(0);
    expect(existsSync(folder)).toBe(true);
    expect(countUnreadChunks(folder)).toBe(1);
  });
});
