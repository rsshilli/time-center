import { readdirSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { RETENTION_DAYS } from "../screenshots/cleanUpScreenshots";
import { chunkFromFileName } from "./recorderProcess";
import type { RecordingStore } from "./RecordingStore";
import type { Transcriber } from "./Transcriber";

/** What recovery and clean-up use from the recordings table. */
type Recordings = Pick<RecordingStore, "listUnfinished" | "listWithAudio" | "finishRecording" | "markAudioDeleted">;

/** The note left on a call the app quit or crashed during. */
export const INTERRUPTED = "Time Center stopped during this call, so its audio file may not play.";

/**
 * Picks up after a quit or crash: closes recordings left open (ending them when their files were last
 * written) and queues every chunk whisper hadn't read yet.
 * @param store The recordings table.
 * @param transcriber Where the chunks go.
 */
export async function recoverRecordings(store: Recordings, transcriber: Pick<Transcriber, "add">): Promise<void> {
  for (const recording of store.listUnfinished()) {
    store.finishRecording(recording.id, (await lastWrittenAt(recording.folder)) ?? recording.start, INTERRUPTED);
  }
  for (const recording of store.listWithAudio()) {
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
    await rm(recording.folder, { recursive: true, force: true });
    store.markAudioDeleted(recording.id, now);
    deleted++;
  }
  return deleted;
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
