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
];
