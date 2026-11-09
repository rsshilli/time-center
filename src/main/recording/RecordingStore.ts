import type { DatabaseSync } from "node:sqlite";
import type { TranscriptLine } from "../../shared/ipc";

/** A recorded call, as stored. Times are milliseconds since 1970. */
export interface StoredRecording {
  id: number;
  start: number;
  /** Null while recording. */
  end: number | null;
  folder: string;
  mic: boolean;
  error: string | null;
  audioDeleted: boolean;
}

/** The recordings and transcript_lines tables (migration 8). */
export class RecordingStore {
  /** @param db The open database. */
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Starts a recording row.
   * @param start When recording began.
   * @param folder Where its audio goes.
   * @returns The new id.
   */
  insertRecording(start: number, folder: string): number {
    const result = this.db
      .prepare("INSERT INTO recordings (started_at, folder) VALUES (?, ?)")
      .run(iso(start), folder);
    return Number(result.lastInsertRowid);
  }

  /**
   * Notes that macOS refused the microphone, so only the other side is being recorded.
   * @param id The recording.
   */
  markNoMic(id: number): void {
    this.db.prepare("UPDATE recordings SET mic = 0 WHERE id = ?").run(id);
  }

  /**
   * Ends a recording.
   * @param id The recording.
   * @param end When it stopped.
   * @param error Why it stopped early, if it did.
   */
  finishRecording(id: number, end: number, error: string | null = null): void {
    this.db
      .prepare("UPDATE recordings SET ended_at = ?, error = COALESCE(?, error) WHERE id = ? AND ended_at IS NULL")
      .run(iso(end), error, id);
  }

  /**
   * Lists recordings still open, i.e. ones the app quit or crashed during.
   * @returns Them, oldest first.
   */
  listUnfinished(): StoredRecording[] {
    const rows = this.db.prepare("SELECT * FROM recordings WHERE ended_at IS NULL ORDER BY id").all();
    return rows.map((row) => mapRecording(row as Record<string, unknown>));
  }

  /**
   * Lists every recording whose audio is still on the Mac.
   * @returns Them, oldest first.
   */
  listWithAudio(): StoredRecording[] {
    const rows = this.db.prepare("SELECT * FROM recordings WHERE audio_deleted_at IS NULL ORDER BY id").all();
    return rows.map((row) => mapRecording(row as Record<string, unknown>));
  }

  /**
   * Lists recordings that overlap a time range; one still going counts as reaching now.
   * @param from Range start.
   * @param to Range end (exclusive).
   * @returns Them, oldest first.
   */
  listRecordings(from: number, to: number): StoredRecording[] {
    const rows = this.db
      .prepare("SELECT * FROM recordings WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at")
      .all(iso(to), iso(from));
    return rows.map((row) => mapRecording(row as Record<string, unknown>));
  }

  /**
   * Finds one recording.
   * @param id Its id.
   * @returns It, or null.
   */
  getRecording(id: number): StoredRecording | null {
    const row = this.db.prepare("SELECT * FROM recordings WHERE id = ?").get(id);
    return row ? mapRecording(row as Record<string, unknown>) : null;
  }

  /**
   * Notes that a recording's audio files were deleted (past the 30-day keep); its transcript stays.
   * @param id The recording.
   * @param at When.
   */
  markAudioDeleted(id: number, at: number): void {
    this.db.prepare("UPDATE recordings SET audio_deleted_at = ? WHERE id = ?").run(iso(at), id);
  }

  /**
   * Adds lines whisper heard.
   * @param recordingId The call.
   * @param lines The lines.
   */
  insertLines(recordingId: number, lines: TranscriptLine[]): void {
    const insert = this.db.prepare(
      "INSERT INTO transcript_lines (recording_id, side, started_at, ended_at, text) VALUES (?, ?, ?, ?, ?)",
    );
    // All of a chunk's lines or none, so a chunk read again after a failure doesn't repeat half of them.
    this.db.exec("BEGIN");
    try {
      for (const line of lines) {
        insert.run(recordingId, line.side, iso(line.start), iso(line.end), line.text);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * A call's transcript, in the order it was said.
   * @param recordingId The call.
   * @returns Its lines.
   */
  listLines(recordingId: number): TranscriptLine[] {
    const rows = this.db
      .prepare("SELECT * FROM transcript_lines WHERE recording_id = ? ORDER BY started_at, id")
      .all(recordingId) as Record<string, unknown>[];
    return rows.map((row) => ({
      side: row.side === "me" ? "me" : "them",
      start: Date.parse(String(row.started_at)),
      end: Date.parse(String(row.ended_at)),
      text: String(row.text),
    }));
  }
}

/**
 * Maps a recordings row.
 * @param row The row.
 * @returns The typed recording.
 */
function mapRecording(row: Record<string, unknown>): StoredRecording {
  return {
    id: Number(row.id),
    start: Date.parse(String(row.started_at)),
    end: row.ended_at === null || row.ended_at === undefined ? null : Date.parse(String(row.ended_at)),
    folder: String(row.folder),
    mic: Number(row.mic) === 1,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    audioDeleted: row.audio_deleted_at !== null && row.audio_deleted_at !== undefined,
  };
}

/**
 * Formats a moment for a TEXT column.
 * @param ms Milliseconds since 1970.
 * @returns ISO 8601 in UTC.
 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}
