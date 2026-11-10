import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingStore } from "../../src/main/recording/RecordingStore";
import {
  INTERRUPTED,
  audioFileName,
  cleanUpRecordings,
  countUnreadChunks,
  nameRecordingAudio,
  recoverRecordings,
} from "../../src/main/recording/recordingFiles";
import { buildRecordingsReport } from "../../src/main/recording/recordingIpc";
import type { CalendarEvent } from "../../src/main/calendar/meetingLinks";
import type { AudioChunk } from "../../src/main/recording/recorderProcess";
import { SpeakerStore } from "../../src/main/speakers/SpeakerStore";
import { Store } from "../../src/main/store/Store";

const NOON = new Date(2026, 10, 6, 12).getTime();
const MIN = 60_000;

describe("audioFileName", () => {
  it("should use the local date and a title safe for Finder, or Call without a meeting", () => {
    expect(audioFileName(NOON, "Yash & Ryan 1-1")).toBe("2026-11-06 Yash & Ryan 1-1");
    expect(audioFileName(NOON, " Q4: plan / budget\n")).toBe("2026-11-06 Q4- plan - budget");
    expect(audioFileName(NOON, "...hidden")).toBe("2026-11-06 hidden");
    expect(audioFileName(NOON, null)).toBe("2026-11-06 Call");
    expect(audioFileName(NOON, "x".repeat(300))).toHaveLength(11 + 120);
  });
});

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

  it("should list a call still recording on its day, named after the real meeting it overlapped most", () => {
    recordings.insertRecording(NOON, "/r/1");
    const guest = [{ email: "yash@example.com", name: "Yash" }];
    const meetings = [
      { title: "Stand-up", start: NOON - 30 * MIN, end: NOON + 2 * MIN, response: "accepted", attendees: guest, provider: null },
      { title: "1-1", start: NOON + 5 * MIN, end: NOON + 30 * MIN, response: "accepted", attendees: guest, provider: null },
      { title: "Pay credit card!", start: NOON, end: NOON + 60 * MIN, response: "accepted", attendees: [], provider: null },
      { title: "Declined", start: NOON, end: NOON + 60 * MIN, response: "declined", attendees: guest, provider: "zoom" },
    ] as CalendarEvent[];
    const report = buildRecordingsReport(
      {
        store: recordings,
        transcriber: { waiting: () => 2, currentProblem: () => null },
        listMeetings: () => meetings,
        countUnread: () => 0,
        actionItems: { getItems: (id) => ({ recordingId: id, items: [{ text: "You: book it", saidAt: NOON }], coveredUntil: NOON, coveredLines: 1, checkedAt: NOON }) },
        speakers: new SpeakerStore(store.db),
        now: () => NOON + 20 * MIN,
      },
      NOON,
    );
    expect(report.recordings).toEqual([
      expect.objectContaining({
        end: null,
        meetingTitle: "1-1",
        waitingChunks: 2,
        audioKept: true,
        actionItems: [{ text: "You: book it", saidAt: NOON }],
        speakers: [],
        nameChoices: ["Yash"],
      }),
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
    const named: number[] = [];
    await recoverRecordings(recordings, { add: (_id, chunk) => queued.push(chunk) }, async (recording) => {
      named.push(recording.id);
    });
    expect(named).toEqual([id]);
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

  it("should move the mixed file out as '<date> <meeting>.m4a', adding (2) when that name is taken", async () => {
    const recordingsDir = join(dir, "recordings");
    /**
     * A finished call whose recorder has written its mixed file.
     * @param name The working folder's name.
     * @returns The call as stored.
     */
    const finishedCall = (name: string) => {
      const folder = join(recordingsDir, ".work", name);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "call.m4a"), "audio");
      const id = recordings.insertRecording(NOON, folder);
      recordings.finishRecording(id, NOON + 30 * MIN);
      return recordings.getRecording(id)!;
    };
    const first = await nameRecordingAudio(recordings, finishedCall("a"), "Yash & Ryan 1-1", recordingsDir);
    const second = await nameRecordingAudio(recordings, finishedCall("b"), "Yash & Ryan 1-1", recordingsDir);
    expect(first).toBe(join(recordingsDir, "2026-11-06 Yash & Ryan 1-1.m4a"));
    expect(second).toBe(join(recordingsDir, "2026-11-06 Yash & Ryan 1-1 (2).m4a"));
    expect(existsSync(first!)).toBe(true);
    expect(existsSync(join(recordingsDir, ".work", "a"))).toBe(false);
    expect(recordings.getRecording(1)!.audioPath).toBe(first);
    expect(await nameRecordingAudio(recordings, recordings.getRecording(1)!, "Again", recordingsDir)).toBeNull();
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
