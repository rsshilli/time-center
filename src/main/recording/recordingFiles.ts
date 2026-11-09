import { existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RETENTION_DAYS } from "../screenshots/cleanUpScreenshots";
import { localStamp } from "../screenshots/ScreenCapturer";
import { chunkFromFileName } from "./recorderProcess";
import type { RecordingStore, StoredRecording } from "./RecordingStore";
import type { Transcriber } from "./Transcriber";

/** What recovery and clean-up use from the recordings table. */
type Recordings = Pick<RecordingStore, "listUnfinished" | "listWithAudio" | "finishRecording" | "markAudioDeleted">;

/** The file the recorder mixes both sides into, in the working folder, before it's named. */
export const MIXED_FILE = "call.m4a";

/** The longest meeting title kept in a file name. */
const MAX_TITLE_LENGTH = 120;

/** The note left on a call the app quit or crashed during. */
export const INTERRUPTED = "Time Center stopped during this call, so its audio file may not play.";

/**
 * Picks up after a quit or crash: closes recordings left open (ending them when their files were last
 * written), names calls whose mixed file was finished after the app quit, and queues every chunk whisper
 * hadn't read yet.
 * @param store The recordings table.
 * @param transcriber Where the chunks go.
 * @param name Names a finished call's audio after its meeting (see nameRecordingAudio).
 */
export async function recoverRecordings(
  store: Recordings,
  transcriber: Pick<Transcriber, "add">,
  name: (recording: StoredRecording) => Promise<unknown>,
): Promise<void> {
  for (const recording of store.listUnfinished()) {
    store.finishRecording(recording.id, (await lastWrittenAt(recording.folder)) ?? recording.start, INTERRUPTED);
  }
  for (const recording of store.listWithAudio()) {
    if (!recording.audioPath) {
      await name(recording);
    }
    for (const name of (await listOrEmpty(join(recording.folder, "chunks"))).sort()) {
      const chunk = chunkFromFileName(join(recording.folder, "chunks", name));
      if (chunk) {
        transcriber.add(recording.id, chunk);
      }
    }
  }
}

/**
 * Deletes the audio of calls older than the 30-day keep (the same as screenshots); their transcripts stay.
 * @param store The recordings table.
 * @param now The current time.
 * @returns How many calls' audio was deleted.
 */
export async function cleanUpRecordings(store: Recordings, now: number): Promise<number> {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  let deleted = 0;
  for (const recording of store.listWithAudio()) {
    if (recording.end === null || recording.start >= cutoff.getTime()) {
      continue;
    }
    // Chunks whisper hasn't read yet (e.g. it was missing for a month) are kept until it has.
    if ((await listOrEmpty(join(recording.folder, "chunks"))).some((name) => name.endsWith(".wav"))) {
      continue;
    }
    if (recording.audioPath) {
      await rm(recording.audioPath, { force: true });
    }
    await rm(recording.folder, { recursive: true, force: true });
    store.markAudioDeleted(recording.id, now);
    deleted++;
  }
  return deleted;
}

/**
 * Moves a finished call's mixed audio out of its working folder into the recordings folder, named after the
 * meeting: "2026-11-09 Yash & Ryan 1-1.m4a" (user's pick: date only; a second one that day gets " (2)").
 * @param store Where the file's path is kept.
 * @param recording The call.
 * @param title The meeting it overlapped most, or null for "Call".
 * @param recordingsDir The recordings folder.
 * @returns The new path, or null when there's nothing to name yet (still mixing, or already named).
 */
export async function nameRecordingAudio(
  store: Pick<RecordingStore, "setAudioPath">,
  recording: StoredRecording,
  title: string | null,
  recordingsDir: string,
): Promise<string | null> {
  const source = join(recording.folder, MIXED_FILE);
  if (recording.audioPath || recording.end === null || !existsSync(source)) {
    return null;
  }
  await mkdir(recordingsDir, { recursive: true });
  const base = audioFileName(recording.start, title);
  let target = join(recordingsDir, `${base}.m4a`);
  for (let copy = 2; existsSync(target); copy++) {
    target = join(recordingsDir, `${base} (${copy}).m4a`);
  }
  await rename(source, target);
  store.setAudioPath(recording.id, target);
  // Tidy away the working folder and its day folder when nothing is left in them (rmdir refuses otherwise,
  // e.g. while whisper still has chunks to read).
  for (const empty of [join(recording.folder, "chunks"), recording.folder, dirname(recording.folder)]) {
    // Finder leaves a .DS_Store in any folder you've opened; it doesn't count as something left.
    await rm(join(empty, ".DS_Store"), { force: true });
    await rmdir(empty).catch(() => {});
  }
  return target;
}

/**
 * Builds a call's file name without its extension: its local date and the meeting's title, made safe for
 * a file name (no slashes or colons, which Finder shows as each other).
 * @param start When the call started.
 * @param title The meeting's title, or null.
 * @returns e.g. "2026-11-09 Yash & Ryan 1-1".
 */
export function audioFileName(start: number, title: string | null): string {
  const clean = (title ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\:]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
  return `${localStamp(start).day} ${clean || "Call"}`;
}

/**
 * Counts the chunks whisper couldn't read in a recording's folder (Transcriber renames them `.failed`).
 * @param folder The recording's folder.
 * @returns How many.
 */
export function countUnreadChunks(folder: string): number {
  try {
    return readdirSync(join(folder, "chunks")).filter((name) => name.endsWith(".wav.failed")).length;
  } catch {
    return 0;
  }
}

/**
 * When anything in a recording's folder was last written.
 * @param folder The folder.
 * @returns The newest modification time, or null when the folder is empty or gone.
 */
async function lastWrittenAt(folder: string): Promise<number | null> {
  let latest: number | null = null;
  for (const name of await listOrEmpty(folder)) {
    const info = await stat(join(folder, name)).catch(() => null);
    if (info && info.isFile()) {
      latest = Math.max(latest ?? 0, info.mtimeMs);
    }
  }
  return latest;
}

/**
 * Lists a folder.
 * @param folder The folder.
 * @returns Its entries, or none when it doesn't exist.
 */
async function listOrEmpty(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch {
    return [];
  }
}
