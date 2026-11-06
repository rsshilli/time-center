import type { DatabaseSync } from "node:sqlite";
import type { ManualEntry, NewManualEntry, SegmentKind } from "../../shared/ipc";

/** A stretch of time with the same front window, as stored. Times are milliseconds since 1970. */
export interface StoredSegment {
  id: number;
  startedAt: number;
  endedAt: number;
  kind: SegmentKind;
  app: string | null;
  bundleId: string | null;
  title: string | null;
  url: string | null;
  domain: string | null;
  project: string | null;
  /** Whether you were on a call (some app using the microphone) the whole stretch. Unset reads as no. */
  onCall?: boolean;
}

/** A new stretch: everything but the id. */
export type NewSegment = Omit<StoredSegment, "id">;

/** A screenshot row, as stored. */
export interface StoredScreenshot {
  id: number;
  takenAt: number;
  status: "taken" | "skipped-busy";
  displayId: string | null;
  path: string | null;
  thumbPath: string | null;
  bytes: number | null;
  cpuPercent: number | null;
  segmentId: number | null;
}

/** A new screenshot row: everything but the id. */
export type NewScreenshot = Omit<StoredScreenshot, "id">;

/**
 * Reads and writes the activity_segments and screenshots tables. Times are stored as ISO text in UTC,
 * which sorts correctly, and handed out as milliseconds.
 */
export class ActivityStore {
  /** @param db The app's open database, already migrated. */
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Stores a new stretch of time.
   * @param segment The stretch.
   * @returns Its id.
   */
  insertSegment(segment: NewSegment): number {
    const result = this.db
      .prepare(
        `INSERT INTO activity_segments (started_at, ended_at, kind, app, bundle_id, title, url, domain, project, on_call)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        iso(segment.startedAt),
        iso(segment.endedAt),
        segment.kind,
        segment.app,
        segment.bundleId,
        segment.title,
        segment.url,
        segment.domain,
        segment.project,
        segment.onCall ? 1 : 0,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Moves a stretch's end time.
   * @param id The stretch.
   * @param endedAt Its new end.
   */
  setSegmentEnd(id: number, endedAt: number): void {
    this.db.prepare("UPDATE activity_segments SET ended_at = ? WHERE id = ?").run(iso(endedAt), id);
  }

  /**
   * Finds where the latest stretch ends, so a new run of the app never records time twice.
   * @returns Its end, or null when nothing was ever recorded.
   */
  getLatestSegmentEnd(): number | null {
    const row = this.db.prepare("SELECT MAX(ended_at) AS ended_at FROM activity_segments").get() as
      | { ended_at: string | null }
      | undefined;
    return row?.ended_at ? Date.parse(row.ended_at) : null;
  }

  /**
   * Lists the stretches that overlap a time range, oldest first.
   * @param from Range start.
   * @param to Range end (exclusive).
   * @returns The stretches, not clipped to the range.
   */
  listSegments(from: number, to: number): StoredSegment[] {
    const rows = this.db
      .prepare("SELECT * FROM activity_segments WHERE started_at < ? AND ended_at > ? ORDER BY started_at, id")
      .all(iso(to), iso(from)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      startedAt: Date.parse(String(row.started_at)),
      endedAt: Date.parse(String(row.ended_at)),
      kind: row.kind as SegmentKind,
      app: textOrNull(row.app),
      bundleId: textOrNull(row.bundle_id),
      title: textOrNull(row.title),
      url: textOrNull(row.url),
      domain: textOrNull(row.domain),
      project: textOrNull(row.project),
      onCall: Number(row.on_call) === 1,
    }));
  }

  /**
   * Stores a screenshot, or a minute skipped because the CPU was busy.
   * @param shot The row.
   * @returns Its id.
   */
  insertScreenshot(shot: NewScreenshot): number {
    const result = this.db
      .prepare(
        `INSERT INTO screenshots (taken_at, status, display_id, path, thumb_path, bytes, cpu_percent, segment_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        iso(shot.takenAt),
        shot.status,
        shot.displayId,
        shot.path,
        shot.thumbPath,
        shot.bytes,
        shot.cpuPercent,
        shot.segmentId,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Finds one screenshot.
   * @param id Its id.
   * @returns The row, or null.
   */
  getScreenshot(id: number): StoredScreenshot | null {
    const row = this.db.prepare("SELECT * FROM screenshots WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapScreenshot(row) : null;
  }

  /**
   * Lists the screenshot rows in a time range, oldest first.
   * @param from Range start.
   * @param to Range end (exclusive).
   * @returns The rows.
   */
  listScreenshots(from: number, to: number): StoredScreenshot[] {
    const rows = this.db
      .prepare("SELECT * FROM screenshots WHERE taken_at >= ? AND taken_at < ? ORDER BY taken_at, id")
      .all(iso(from), iso(to)) as Record<string, unknown>[];
    return rows.map(mapScreenshot);
  }

  /**
   * Deletes the screenshot rows older than a moment.
   * @param before The cut-off.
   * @returns How many rows were deleted.
   */
  deleteScreenshotsBefore(before: number): number {
    const result = this.db.prepare("DELETE FROM screenshots WHERE taken_at < ?").run(iso(before));
    return Number(result.changes);
  }

  /**
   * Stores a stretch you marked on the timeline yourself.
   * @param entry The stretch.
   * @returns Its id.
   */
  insertManualEntry(entry: NewManualEntry): number {
    const result = this.db
      .prepare("INSERT INTO manual_entries (started_at, ended_at, category, event_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(iso(entry.start), iso(entry.end), entry.category, entry.eventId, iso(Date.now()));
    return Number(result.lastInsertRowid);
  }

  /**
   * Lists the stretches you marked that overlap a time range, oldest entry first.
   * @param from Range start.
   * @param to Range end (exclusive).
   * @returns The entries, not clipped to the range.
   */
  listManualEntries(from: number, to: number): ManualEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM manual_entries WHERE started_at < ? AND ended_at > ? ORDER BY id")
      .all(iso(to), iso(from)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      start: Date.parse(String(row.started_at)),
      end: Date.parse(String(row.ended_at)),
      category: String(row.category),
      eventId: textOrNull(row.event_id),
    }));
  }

  /**
   * Deletes a stretch you marked.
   * @param id Its id.
   */
  deleteManualEntry(id: number): void {
    this.db.prepare("DELETE FROM manual_entries WHERE id = ?").run(id);
  }
}

/**
 * Maps a screenshots row.
 * @param row The row.
 * @returns The typed screenshot.
 */
function mapScreenshot(row: Record<string, unknown>): StoredScreenshot {
  return {
    id: Number(row.id),
    takenAt: Date.parse(String(row.taken_at)),
    status: row.status as StoredScreenshot["status"],
    displayId: textOrNull(row.display_id),
    path: textOrNull(row.path),
    thumbPath: textOrNull(row.thumb_path),
    bytes: row.bytes === null ? null : Number(row.bytes),
    cpuPercent: row.cpu_percent === null ? null : Number(row.cpu_percent),
    segmentId: row.segment_id === null ? null : Number(row.segment_id),
  };
}

/**
 * Formats a moment the way the tables store it.
 * @param ms Milliseconds since 1970.
 * @returns ISO 8601 text in UTC.
 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Reads a nullable text column.
 * @param value The column value.
 * @returns The text, or null.
 */
function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
