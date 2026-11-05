import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../../src/main/store/migrations";
import { Store } from "../../src/main/store/Store";

describe("Store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tc-store-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("should apply every migration and record the schema version", () => {
    const store = new Store(join(dir, "a.db"));
    const { user_version } = store.db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(user_version).toBe(MIGRATIONS.length);
    store.close();
  });

  it("should not re-run migrations when the same file is opened again", () => {
    const path = join(dir, "a.db");
    const first = new Store(path);
    first.setSetting("k", "v");
    first.close();
    const second = new Store(path);
    expect(second.getSetting("k")).toBe("v");
    second.close();
  });

  it("should store, overwrite and delete settings", () => {
    const store = new Store(":memory:");
    expect(store.getSetting("missing")).toBeNull();
    store.setSetting("k", "one");
    store.setSetting("k", "two");
    expect(store.getSetting("k")).toBe("two");
    store.setSetting("k", null);
    expect(store.getSetting("k")).toBeNull();
    store.close();
  });

  it("should report the latest successful backup and ignore later failures", () => {
    const store = new Store(":memory:");
    const ok = store.startBackupRun(new Date("2026-11-01T00:00:00Z"));
    store.finishBackupRun(ok, { status: "success", objectKey: "k1", bytes: 10 });
    const bad = store.startBackupRun(new Date("2026-11-02T00:00:00Z"));
    store.finishBackupRun(bad, { status: "failed", error: "boom" });

    expect(store.getLastSuccessfulBackup()?.objectKey).toBe("k1");
    expect(store.getLastBackupRun()).toMatchObject({ status: "failed", error: "boom" });
    store.close();
  });

  it("should mark a backup cut off by a quit as failed when the database is opened again", () => {
    const path = join(dir, "a.db");
    const first = new Store(path);
    first.startBackupRun(new Date("2026-11-04T18:00:00Z"));
    first.close();

    const second = new Store(path);
    expect(second.getLastBackupRun()).toMatchObject({ status: "failed", error: expect.stringContaining("Interrupted") });
    second.close();
  });
});
