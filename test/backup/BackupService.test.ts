import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { BACKUP_INTERVAL_MS, BACKUP_SETTING_KEYS, BackupService } from "../../src/main/backup/BackupService";
import { Store } from "../../src/main/store/Store";
import { FolderObjectStorage } from "../helpers/FolderObjectStorage";

describe("BackupService", () => {
  let dir: string;
  let store: Store;
  let bucket: FolderObjectStorage;
  let service: BackupService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tc-backup-"));
    store = new Store(join(dir, "live.db"));
    bucket = new FolderObjectStorage(join(dir, "bucket"));
    service = new BackupService(store, () => bucket);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("should be off, and never due, until a bucket is configured", () => {
    expect(service.getSettings()).toBeNull();
    expect(service.isBackupDue(new Date())).toBe(false);
  });

  it("should default the region and profile once a bucket is set", () => {
    store.setSetting(BACKUP_SETTING_KEYS.bucket, "my-bucket");
    expect(service.getSettings()).toEqual({
      bucket: "my-bucket",
      region: "us-east-1",
      profile: "default",
      kmsKeyId: null,
    });
  });

  it("should restore a backup that holds the data written before it and pass the integrity check", async () => {
    store.setSetting(BACKUP_SETTING_KEYS.bucket, "my-bucket");
    store.setSetting(BACKUP_SETTING_KEYS.kmsKeyId, "alias/time-center");
    store.setSetting("marker", "written-before-backup");

    const { objectKey, bytes } = await service.runBackup(new Date("2026-11-04T18:00:00.123Z"));
    store.setSetting("marker", "written-after-backup");

    expect(objectKey).toBe("time-center/2026/time-center-2026-11-04T18-00-00Z.db.gz");
    expect(bytes).toBeGreaterThan(0);
    expect(bucket.kmsKeysByObject.get(objectKey)).toBe("alias/time-center");

    const restoredPath = join(dir, "restored.db");
    await service.restoreBackup(objectKey, restoredPath);
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    const row = restored.prepare("SELECT value FROM settings WHERE key = 'marker'").get() as { value: string };
    restored.close();
    expect(row.value).toBe("written-before-backup");
  });

  it("should restore to one self-contained file, with no WAL companions or partial file left beside it", async () => {
    store.setSetting(BACKUP_SETTING_KEYS.bucket, "my-bucket");
    const { objectKey } = await service.runBackup(new Date());
    const restoreDir = join(dir, "restore");
    await mkdir(restoreDir);

    await service.restoreBackup(objectKey, join(restoreDir, "restored.db"));

    expect(await readdir(restoreDir)).toEqual(["restored.db"]);
    const restored = new DatabaseSync(join(restoreDir, "restored.db"));
    const { journal_mode } = restored.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    restored.close();
    expect(journal_mode).toBe("delete");
  });

  it("should refuse to restore over the live database or an existing file", async () => {
    store.setSetting(BACKUP_SETTING_KEYS.bucket, "my-bucket");
    const { objectKey } = await service.runBackup(new Date());
    const existing = join(dir, "existing.db");
    await writeFile(existing, "keep me");

    await expect(service.restoreBackup(objectKey, store.dbPath)).rejects.toThrow(/live database/);
    await expect(service.restoreBackup(objectKey, existing)).rejects.toThrow(/already exists/);
    expect(await readFile(existing, "utf8")).toBe("keep me");
  });

  it("should record a success and stop being due for a week", async () => {
    store.setSetting(BACKUP_SETTING_KEYS.bucket, "my-bucket");
    const start = new Date();
    expect(service.isBackupDue(start)).toBe(true);

    await service.runBackup(start);

    expect(store.getLastSuccessfulBackup()?.status).toBe("success");
    expect(service.isBackupDue(new Date(start.getTime() + BACKUP_INTERVAL_MS - 60_000))).toBe(false);
    expect(service.isBackupDue(new Date(start.getTime() + BACKUP_INTERVAL_MS + 60_000))).toBe(true);
  });

  it("should record a failed upload with its error and stay due", async () => {
    store.setSetting(BACKUP_SETTING_KEYS.bucket, "my-bucket");
    const failing = new BackupService(store, () => ({
      put: async () => {
        throw new Error("AccessDenied");
      },
      get: async () => undefined,
      list: async () => [],
    }));

    await expect(failing.runBackup(new Date())).rejects.toThrow("AccessDenied");
    expect(store.getLastBackupRun()).toMatchObject({ status: "failed", error: "AccessDenied" });
    expect(failing.isBackupDue(new Date())).toBe(true);
  });

  it("should reject a restore whose file is not a valid database", async () => {
    store.setSetting(BACKUP_SETTING_KEYS.bucket, "my-bucket");
    const garbage = new BackupService(store, () => ({
      put: async () => undefined,
      get: async (_key: string, filePath: string) => {
        await writeFile(filePath, gzipSync(Buffer.from("this is not sqlite")));
      },
      list: async () => [],
    }));
    const restoreDir = join(dir, "restore");
    await mkdir(restoreDir);

    await expect(garbage.restoreBackup("k", join(restoreDir, "bad.db"))).rejects.toThrow(/not a healthy database/);
    expect(await readdir(restoreDir)).toEqual([]);
  });

  it("should list backups newest first", async () => {
    store.setSetting(BACKUP_SETTING_KEYS.bucket, "my-bucket");
    await service.runBackup(new Date("2026-10-01T00:00:00Z"));
    await service.runBackup(new Date("2026-11-01T00:00:00Z"));
    const keys = await service.listBackups();
    expect(keys[0]).toContain("2026-11-01");
    expect(keys).toHaveLength(2);
  });
});
