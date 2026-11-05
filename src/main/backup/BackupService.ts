import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { Store } from "../store/Store";
import type { ObjectStorage } from "./ObjectStorage";

/** Where backups go. Read from settings; the backup is off until a bucket is set. */
export interface BackupSettings {
  bucket: string;
  region: string;
  profile: string;
  /** Optional customer-managed KMS key. Without it S3 uses the account's default `aws/s3` key. */
  kmsKeyId: string | null;
}

/** Settings keys for the backup destination. */
export const BACKUP_SETTING_KEYS = {
  bucket: "backup.bucket",
  region: "backup.region",
  profile: "backup.profile",
  kmsKeyId: "backup.kmsKeyId",
} as const;

/** One week, in milliseconds: how often a backup is due. */
export const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** The S3 key prefix every backup is written under. */
const OBJECT_PREFIX = "time-center/";

/**
 * Backs the local database up to S3 and restores it. A backup takes a consistent snapshot with SQLite's
 * online backup (safe while the app keeps writing), gzips it and uploads it with KMS encryption. A
 * restore downloads, unzips and runs SQLite's integrity check before handing the file back.
 */
export class BackupService {
  /**
   * @param store The live database, and the record of past backup runs.
   * @param createStorage Builds the S3 client for the configured destination; injected for tests.
   */
  constructor(
    private readonly store: Store,
    private readonly createStorage: (settings: BackupSettings) => ObjectStorage,
  ) {}

  /**
   * Reads the backup destination from settings.
   * @returns The settings, or null when no bucket is configured (backups are off).
   */
  getSettings(): BackupSettings | null {
    const bucket = this.store.getSetting(BACKUP_SETTING_KEYS.bucket);
    if (!bucket) {
      return null;
    }
    return {
      bucket,
      region: this.store.getSetting(BACKUP_SETTING_KEYS.region) || "us-east-1",
      profile: this.store.getSetting(BACKUP_SETTING_KEYS.profile) || "default",
      kmsKeyId: this.store.getSetting(BACKUP_SETTING_KEYS.kmsKeyId) || null,
    };
  }

  /**
   * Saves the backup destination. An empty bucket turns backups off; other empty fields fall back to defaults.
   * @param input The fields from the settings screen.
   */
  saveSettings(input: { bucket: string; region: string; profile: string; kmsKeyId: string }): void {
    this.store.setSetting(BACKUP_SETTING_KEYS.bucket, input.bucket.trim() || null);
    this.store.setSetting(BACKUP_SETTING_KEYS.region, input.region.trim() || null);
    this.store.setSetting(BACKUP_SETTING_KEYS.profile, input.profile.trim() || null);
    this.store.setSetting(BACKUP_SETTING_KEYS.kmsKeyId, input.kmsKeyId.trim() || null);
  }

  /**
   * When the last backup succeeded.
   * @returns An ISO timestamp, or null when no backup has succeeded yet.
   */
  getLastSuccessAt(): string | null {
    return this.store.getLastSuccessfulBackup()?.finishedAt ?? null;
  }

  /**
   * Says whether a weekly backup is due: configured, and no success in the last week. A laptop that
   * slept through its slot is due at the next check, which is how a missed week catches up.
   * @param now The current time.
   * @returns True when runBackup should be called.
   */
  isBackupDue(now: Date): boolean {
    if (!this.getSettings()) {
      return false;
    }
    const lastSuccessAt = this.getLastSuccessAt();
    if (!lastSuccessAt) {
      return true;
    }
    return now.getTime() - new Date(lastSuccessAt).getTime() >= BACKUP_INTERVAL_MS;
  }

  /**
   * Snapshots, compresses and uploads the database, recording the attempt either way.
   * @param now The time stamped on the backup.
   * @returns The S3 object key and the compressed size.
   */
  async runBackup(now: Date): Promise<{ objectKey: string; bytes: number }> {
    const settings = this.getSettings();
    if (!settings) {
      throw new Error("Backups are not set up: no S3 bucket is configured.");
    }
    const runId = this.store.startBackupRun(now);
    let workDir: string | null = null;
    try {
      workDir = await mkdtemp(join(tmpdir(), "time-center-backup-"));
      const gzPath = await this.snapshotAndCompress(workDir);
      const objectKey = this.objectKeyFor(now);
      await this.createStorage(settings).put(objectKey, gzPath, settings.kmsKeyId);
      const { size: bytes } = await stat(gzPath);
      this.store.finishBackupRun(runId, { status: "success", objectKey, bytes });
      return { objectKey, bytes };
    } catch (error) {
      this.store.finishBackupRun(runId, { status: "failed", error: errorText(error) });
      throw error;
    } finally {
      if (workDir) {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Downloads a backup into a new file and proves it is a healthy SQLite database. It never touches
   * the live database; swapping the file in is a separate, deliberate step (see swapInRestoredDatabase).
   * The file only appears at the destination once it has passed the check, so a failed restore leaves
   * nothing behind.
   * @param objectKey The S3 key of the backup to restore.
   * @param destinationPath Where to write the restored database file. Must not exist yet.
   */
  async restoreBackup(objectKey: string, destinationPath: string): Promise<void> {
    const settings = this.getSettings();
    if (!settings) {
      throw new Error("Backups are not set up: no S3 bucket is configured.");
    }
    if (resolve(destinationPath) === resolve(this.store.dbPath)) {
      throw new Error("A backup can't be restored over the live database.");
    }
    if (existsSync(destinationPath)) {
      throw new Error(`Won't overwrite ${destinationPath}: the file already exists.`);
    }
    const workDir = await mkdtemp(join(tmpdir(), "time-center-restore-"));
    const partialPath = `${destinationPath}.partial`;
    try {
      const gzPath = join(workDir, "backup.db.gz");
      await this.createStorage(settings).get(objectKey, gzPath);
      await pipeline(createReadStream(gzPath), createGunzip(), createWriteStream(partialPath));
      checkAndDetachJournal(partialPath);
      await rename(partialPath, destinationPath);
    } finally {
      await removeDatabaseFiles(partialPath);
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Lists the backups in the bucket, newest first.
   * @returns The S3 keys.
   */
  async listBackups(): Promise<string[]> {
    const settings = this.getSettings();
    if (!settings) {
      return [];
    }
    const keys = await this.createStorage(settings).list(OBJECT_PREFIX);
    return keys.sort().reverse();
  }

  /**
   * Takes a consistent copy of the live database and gzips it.
   * @param workDir A scratch folder that the caller deletes.
   * @returns The path of the gzipped snapshot.
   */
  private async snapshotAndCompress(workDir: string): Promise<string> {
    const snapshotPath = join(workDir, "snapshot.db");
    await sqliteBackup(this.store.db, snapshotPath);
    const gzPath = `${snapshotPath}.gz`;
    await pipeline(createReadStream(snapshotPath), createGzip({ level: 9 }), createWriteStream(gzPath));
    return gzPath;
  }

  /**
   * Builds the S3 key for a backup, sortable by time: `time-center/2026/time-center-2026-11-04T18-00-00Z.db.gz`.
   * @param now The backup time.
   * @returns The key.
   */
  private objectKeyFor(now: Date): string {
    const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
    return `${OBJECT_PREFIX}${now.getUTCFullYear()}/time-center-${stamp}.db.gz`;
  }
}

/**
 * Turns anything thrown into a readable message for the backup history.
 * @param error What was thrown.
 * @returns Its message.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs SQLite's integrity check on a restored file and switches it out of WAL mode, so it is one
 * self-contained file with no `-wal`/`-shm` companions to lose when it is moved.
 * @param dbPath The file to check.
 */
function checkAndDetachJournal(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (row.integrity_check !== "ok") {
      throw new Error(`The restored database failed its integrity check: ${row.integrity_check}`);
    }
    db.exec("PRAGMA journal_mode = DELETE");
  } catch (error) {
    throw new Error(`The backup is not a healthy database: ${errorText(error)}`);
  } finally {
    db.close();
  }
}

/**
 * Deletes a database file and any WAL companions beside it; missing files are fine.
 * @param dbPath The database file.
 */
async function removeDatabaseFiles(dbPath: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    await rm(`${dbPath}${suffix}`, { force: true });
  }
}
