import type { DatabaseSync } from "node:sqlite";
import { MEETING_TYPE_LABELS, type MeetingType } from "../../shared/ipc";
import type { Attendee, CalendarEvent } from "./meetingLinks";

/** What happened at a meeting's join time. */
export type JoinStatus = "joined" | "skipped" | "failed";

/** Who set a meeting's type. */
export type MeetingTypeSource = "haiku" | "you";

/** A meeting with its type, which it shares with every occurrence of its repeating series. */
export interface TypedEvent extends CalendarEvent {
  type: MeetingType | null;
  typeSource: MeetingTypeSource | null;
}

/** The columns every meeting query reads. */
const EVENT_COLUMNS = "event_id, title, starts_at, ends_at, response, provider, join_url, attendees, series_id";

/** The start of every query that reads whole meetings. */
const SELECT_EVENTS = `SELECT ${EVENT_COLUMNS} FROM calendar_events`;

/** A calendar_events row as SQLite returns it. */
interface EventRow {
  event_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  response: string;
  provider: CalendarEvent["provider"];
  join_url: string | null;
  attendees: string;
  series_id: string | null;
}

/** A calendar_events row joined to its series' type. */
interface TypedEventRow extends EventRow {
  type: string | null;
  source: MeetingTypeSource | null;
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
         (event_id, title, starts_at, ends_at, response, provider, join_url, attendees, series_id, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(event.attendees),
          event.seriesId,
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
   * Lists the meetings overlapping a window with their types, earliest first.
   * @param from Meetings ending after this.
   * @param to Meetings starting before this.
   * @returns The meetings, declined ones included.
   */
  listTypedEvents(from: number, to: number): TypedEvent[] {
    const rows = this.db
      .prepare(
        `SELECT ${EVENT_COLUMNS.split(", ").map((column) => `e.${column}`).join(", ")}, t.type, t.source
         FROM calendar_events e LEFT JOIN meeting_types t ON t.series_id = e.series_id
         WHERE e.ends_at > ? AND e.starts_at < ? ORDER BY e.starts_at, e.event_id`,
      )
      .all(iso(from), iso(to)) as unknown as TypedEventRow[];
    return rows.map((row) => ({
      ...toEvent(row),
      type: isMeetingType(row.type) ? row.type : null,
      typeSource: isMeetingType(row.type) ? row.source : null,
    }));
  }

  /**
   * Lists the repeating series (and one-off meetings) that have no type yet, one occurrence each — the
   * latest — newest first. Declined meetings are left out, since their time never counts, and so are
   * blocks with nobody else invited ("Drive to …"), which have nothing for Haiku to go on.
   * @param limit The most to return.
   * @returns One meeting per series.
   */
  listUntypedSeries(limit: number): CalendarEvent[] {
    const rows = this.db
      .prepare(
        `SELECT ${EVENT_COLUMNS}, MAX(starts_at) AS latest FROM calendar_events
         WHERE response != 'declined' AND attendees != '[]' AND series_id NOT IN (SELECT series_id FROM meeting_types)
         GROUP BY series_id ORDER BY latest DESC LIMIT ?`,
      )
      .all(limit) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /**
   * Records a series' type. Haiku's guess never replaces one you set; yours always replaces the guess.
   * @param seriesId The repeating series, or a one-off meeting's id.
   * @param type Its type.
   * @param source Who decided.
   * @param at When.
   */
  setMeetingType(seriesId: string, type: MeetingType, source: MeetingTypeSource, at: number): void {
    this.db
      .prepare(
        `INSERT INTO meeting_types (series_id, type, source, decided_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (series_id) DO UPDATE SET type = excluded.type, source = excluded.source,
           decided_at = excluded.decided_at
         WHERE excluded.source = 'you' OR meeting_types.source = 'haiku'`,
      )
      .run(seriesId, type, source, iso(at));
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
    seriesId: row.series_id ?? row.event_id,
    attendees: parseAttendees(row.attendees),
  };
}

/**
 * Reads the stored attendee list, treating anything unreadable as nobody.
 * @param text The JSON text.
 * @returns The attendees.
 */
function parseAttendees(text: string): Attendee[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as Attendee[]) : [];
  } catch {
    return [];
  }
}

/**
 * Says whether stored text names a meeting type this version knows.
 * @param type The text.
 * @returns True when it does.
 */
export function isMeetingType(type: unknown): type is MeetingType {
  return typeof type === "string" && Object.hasOwn(MEETING_TYPE_LABELS, type);
}

/**
 * Formats milliseconds as ISO text in UTC.
 * @param ms The moment.
 * @returns e.g. "2026-11-05T15:00:00.000Z".
 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}
