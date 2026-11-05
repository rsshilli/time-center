/**
 * Schema migrations, oldest first. The database's `PRAGMA user_version` records how many have run, so
 * only append to this list — never edit or reorder an entry that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE backup_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    object_key  TEXT,
    bytes       INTEGER,
    error       TEXT
  );
  `,
  `
  -- One stretch of time with the same front window. kind: active (working in an app), idle (away from
  -- the keyboard), untracked (an ignored app such as Edge was in front; nothing else is stored).
  CREATE TABLE activity_segments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at   TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('active', 'idle', 'untracked')),
    app        TEXT,
    bundle_id  TEXT,
    title      TEXT,
    url        TEXT,
    domain     TEXT,
    project    TEXT
  );
  CREATE INDEX activity_segments_started_at ON activity_segments (started_at);
  CREATE INDEX activity_segments_ended_at ON activity_segments (ended_at);

  -- One row per display per minute screenshot, plus one row per minute skipped because the CPU was busy.
  CREATE TABLE screenshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    taken_at    TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('taken', 'skipped-busy')),
    display_id  TEXT,
    path        TEXT,
    thumb_path  TEXT,
    bytes       INTEGER,
    cpu_percent REAL,
    segment_id  INTEGER REFERENCES activity_segments (id) ON DELETE SET NULL
  );
  CREATE INDEX screenshots_taken_at ON screenshots (taken_at);
  `,
  `
  -- Meetings on the main Google calendar, refreshed every few minutes for the hours ahead. One row per
  -- occurrence: Google gives each occurrence of a repeating meeting its own id.
  CREATE TABLE calendar_events (
    event_id   TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    starts_at  TEXT NOT NULL,
    ends_at    TEXT NOT NULL,
    -- Your answer to the invitation: accepted, tentative, needsAction or declined.
    response   TEXT NOT NULL,
    -- meet, zoom or teams; null when the event has no meeting link.
    provider   TEXT,
    join_url   TEXT,
    synced_at  TEXT NOT NULL
  );
  CREATE INDEX calendar_events_starts_at ON calendar_events (starts_at);

  -- What happened at a meeting's join time. Keyed by the start too, so a moved meeting is decided afresh.
  CREATE TABLE meeting_joins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   TEXT NOT NULL,
    starts_at  TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('joined', 'skipped', 'failed')),
    decided_at TEXT NOT NULL,
    error      TEXT
  );
  CREATE UNIQUE INDEX meeting_joins_event ON meeting_joins (event_id, starts_at);
  `,
  `
  -- The link each decision was about, so a meeting that moves (or gets a new id) after you joined it
  -- isn't opened a second time.
  ALTER TABLE meeting_joins ADD COLUMN join_url TEXT;
  CREATE INDEX meeting_joins_url ON meeting_joins (join_url, decided_at);
  `,
  `
  -- Who else was invited (JSON list of {email, name}) and the repeating meeting each occurrence belongs to.
  ALTER TABLE calendar_events ADD COLUMN attendees TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE calendar_events ADD COLUMN series_id TEXT;
  UPDATE calendar_events SET series_id = event_id;

  -- Each meeting's type, kept per repeating series so every occurrence shares it. Kept apart from
  -- calendar_events, which each sync rewrites. source 'you' is a correction Haiku never overwrites.
  CREATE TABLE meeting_types (
    series_id  TEXT PRIMARY KEY,
    type       TEXT NOT NULL,
    source     TEXT NOT NULL CHECK (source IN ('haiku', 'you')),
    decided_at TEXT NOT NULL
  );
  `,
  `
  -- 1 when some app was using the microphone for the whole stretch (a call), so a meeting held in any app
  -- counts as attended. Stretches recorded before this read as 0.
  ALTER TABLE activity_segments ADD COLUMN on_call INTEGER NOT NULL DEFAULT 0;
  `,
];
