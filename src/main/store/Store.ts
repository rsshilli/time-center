import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations";

/** One row of the backup_runs table: a single attempt to back the database up. */
export interface BackupRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "failed";
  objectKey: string | null;
  bytes: number | null;
  error: string | null;
}

/**
 * The app's local SQLite database. Owns the connection, applies schema migrations on open, and offers
 * small typed helpers for settings and backup history. Uses Node's built-in `node:sqlite`, which ships
 * inside Electron, so there is no native module to rebuild.
 */
export class Store {
  readonly db: DatabaseSync;

  /**
   * Opens (or creates) the database file and brings its schema up to date.
   * @param dbPath Absolute path of the database file, or ":memory:" for tests.
   */
  constructor(readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    // secure_delete: a forgotten voiceprint is overwritten, not left in free pages that go into the backup.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    this.migrate();
    this.failInterruptedBackupRuns();
  }

  /**
   * Reads a setting.
   * @param key The setting name.
   * @returns The stored value, or null when it was never set.
   */
  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  /**
   * Writes a setting, or deletes it when the value is null.
   * @param key The setting name.
   * @param value The new value; null removes the setting.
   */
  setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      return;
    }
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /**
   * Records the start of a backup attempt.
   * @param startedAt When the attempt began.
   * @returns The id of the new backup run.
   */
  startBackupRun(startedAt: Date): number {
    const result = this.db
      .prepare("INSERT INTO backup_runs (started_at, status) VALUES (?, 'running')")
      .run(startedAt.toISOString());
    return Number(result.lastInsertRowid);
  }

  /**
   * Records how a backup attempt ended.
   * @param id The backup run id from startBackupRun.
   * @param outcome Success with the object key and size, or failure with the error text.
   */
  finishBackupRun(
    id: number,
    outcome: { status: "success"; objectKey: string; bytes: number } | { status: "failed"; error: string },
  ): void {
    const finishedAt = new Date().toISOString();
    if (outcome.status === "success") {
      this.db
        .prepare("UPDATE backup_runs SET finished_at = ?, status = 'success', object_key = ?, bytes = ? WHERE id = ?")
        .run(finishedAt, outcome.objectKey, outcome.bytes, id);
      return;
    }
    this.db
      .prepare("UPDATE backup_runs SET finished_at = ?, status = 'failed', error = ? WHERE id = ?")
      .run(finishedAt, outcome.error, id);
  }

  /**
   * Finds the most recent backup attempt that finished successfully.
   * @returns That run, or null when no backup has ever succeeded.
   */
  getLastSuccessfulBackup(): BackupRun | null {
    return this.queryBackupRun("SELECT * FROM backup_runs WHERE status = 'success' ORDER BY finished_at DESC LIMIT 1");
  }

  /**
   * Finds the most recent backup attempt, whatever its outcome.
   * @returns That run, or null when no backup was ever attempted.
   */
  getLastBackupRun(): BackupRun | null {
    return this.queryBackupRun("SELECT * FROM backup_runs ORDER BY id DESC LIMIT 1");
  }

  /** Closes the database connection. */
  close(): void {
    this.db.close();
  }

  /**
   * Applies every migration newer than the database's `user_version`, each in its own transaction.
   */
  private migrate(): void {
    const { user_version: current } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[version]);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  /**
   * Marks backup runs still "running" as failed. Only one copy of the app runs, so on open any such row
   * belongs to an attempt cut off by a quit or crash and would otherwise stay "running" forever.
   */
  private failInterruptedBackupRuns(): void {
    this.db
      .prepare("UPDATE backup_runs SET finished_at = ?, status = 'failed', error = ? WHERE status = 'running'")
      .run(new Date().toISOString(), "Interrupted: Time Center closed during the backup.");
  }

  /**
   * Runs a query that returns at most one backup_runs row and maps it to a BackupRun.
   * @param sql The query.
   * @returns The mapped row, or null when there is none.
   */
  private queryBackupRun(sql: string): BackupRun | null {
    const row = this.db.prepare(sql).get() as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      id: Number(row.id),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      status: row.status as BackupRun["status"],
      objectKey: row.object_key === null ? null : String(row.object_key),
      bytes: row.bytes === null ? null : Number(row.bytes),
      error: row.error === null ? null : String(row.error),
    };
  }
}
