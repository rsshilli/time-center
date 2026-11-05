import type { DatabaseSync } from "node:sqlite";
import type { CalendarEvent } from "./meetingLinks";

/** What happened at a meeting's join time. */
export type JoinStatus = "joined" | "skipped" | "failed";

/** The columns every meeting query reads. */
const SELECT_EVENTS = "SELECT event_id, title, starts_at, ends_at, response, provider, join_url FROM calendar_events";

/** A calendar_events row as SQLite returns it. */
interface EventRow {
  event_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  response: string;
  provider: CalendarEvent["provider"];
  join_url: string | null;
}

/**
 * Reads and writes the calendar_events and meeting_joins tables. Times are stored as ISO text in UTC and
 * handed out as milliseconds, like the activity tables.
 */
export class CalendarStore {
  /** @param db The app's open database, already migrated. */
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Replaces the meetings that start inside a window with a fresh copy from Google, so a meeting that was
   * moved out of the window or deleted disappears. Meetings outside the window are kept as history.
   * @param from The window's start.
   * @param to Its end.
   * @param events The meetings Google listed for it.
   * @param syncedAt When they were fetched.
   */
  replaceEvents(from: number, to: number, events: CalendarEvent[], syncedAt: number): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO calendar_events
         (event_id, title, starts_at, ends_at, response, provider, join_url, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM calendar_events WHERE starts_at >= ? AND starts_at < ?").run(iso(from), iso(to));
      for (const event of events) {
        insert.run(
          event.eventId,
          event.title,
          iso(event.start),
          iso(event.end),
          event.response,
          event.provider,
          event.joinUrl,
          iso(syncedAt),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Lists the meetings that haven't ended by a moment and start before another, soonest first.
   * @param from Meetings ending after this.
   * @param to Meetings starting before this.
   * @returns The meetings.
   */
  listEvents(from: number, to: number): CalendarEvent[] {
    const rows = this.db
      .prepare(`${SELECT_EVENTS} WHERE ends_at > ? AND starts_at < ? ORDER BY starts_at, event_id`)
      .all(iso(from), iso(to)) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /**
   * Finds one meeting by id.
   * @param eventId The meeting.
   * @returns It, or null.
   */
  getEvent(eventId: string): CalendarEvent | null {
    const row = this.db.prepare(`${SELECT_EVENTS} WHERE event_id = ?`).get(eventId) as unknown as EventRow | undefined;
    return row ? toEvent(row) : null;
  }

  /**
   * Records what happened at a meeting's join time; the first decision for an occurrence stands.
   * @param eventId The meeting.
   * @param start Its start, so a moved meeting is decided afresh.
   * @param status What happened.
   * @param at When.
   * @param error Why it failed or was skipped, if it says.
   * @param joinUrl The meeting's link.
   * @returns False when this occurrence had already been decided.
   */
  recordJoin(
    eventId: string,
    start: number,
    status: JoinStatus,
    at: number,
    error: string | null = null,
    joinUrl: string | null = null,
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO meeting_joins (event_id, starts_at, status, decided_at, error, join_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(eventId, iso(start), status, iso(at), error, joinUrl);
    return Number(result.changes) > 0;
  }

  /**
   * Says whether a meeting link was joined since a moment.
   * @param joinUrl The link.
   * @param since The moment.
   * @returns True when it was.
   */
  wasJoinedSince(joinUrl: string, since: number): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM meeting_joins WHERE join_url = ? AND status = 'joined' AND decided_at >= ? LIMIT 1")
      .get(joinUrl, iso(since));
    return row !== undefined;
  }

  /**
   * Reads what happened at a meeting's join time.
   * @param eventId The meeting.
   * @param start Its start.
   * @returns The decision, or null while undecided.
   */
  getJoin(eventId: string, start: number): JoinStatus | null {
    const row = this.db
      .prepare("SELECT status FROM meeting_joins WHERE event_id = ? AND starts_at = ?")
      .get(eventId, iso(start)) as { status: JoinStatus } | undefined;
    return row?.status ?? null;
  }
}

/**
 * Turns a row into a meeting.
 * @param row The row.
 * @returns The meeting.
 */
function toEvent(row: EventRow): CalendarEvent {
  return {
    eventId: row.event_id,
    title: row.title,
    start: Date.parse(row.starts_at),
    end: Date.parse(row.ends_at),
    response: row.response,
    provider: row.provider,
    joinUrl: row.join_url,
  };
}

/**
 * Formats milliseconds as ISO text in UTC.
 * @param ms The moment.
 * @returns e.g. "2026-11-05T15:00:00.000Z".
 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}
