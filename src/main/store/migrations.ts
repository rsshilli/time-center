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
];
