import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  it("should start your voice afresh when adding per-call shares, emptying one you confirmed rather than dropping it", () => {
    const path = join(dir, "a.db");
    const old = new DatabaseSync(path);
    MIGRATIONS.slice(0, 17).forEach((migration) => old.exec(migration));
    const now = "2026-11-10T12:00:00.000Z";
    const print = new Uint8Array(new Float32Array([0.6, 0.8]).buffer);
    old.exec(`INSERT INTO recordings (id, started_at, folder, your_voice_learned_at) VALUES (1, '${now}', '/r', '${now}'), (2, '${now}', '/r', '${now}')`);
    const voice = old.prepare("INSERT INTO voices (id, name, embedding, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    voice.run(1, "You", print, 40, now, now);
    voice.run(2, "Dana", print, 3, now, now);
    const speaker = old.prepare(
      "INSERT INTO call_speakers (id, recording_id, number, embedding, weight, voice_id, voice_score, confirmed, named_embedding, named_weight) VALUES (?, 1, ?, ?, 1, ?, ?, ?, ?, ?)",
    );
    speaker.run(1, 1, print, 1, 1, 1, print, 1); // "That's me", confirmed
    speaker.run(2, 2, print, 1, 0.9, 0, null, null); // matched to You
    speaker.run(3, 3, print, 2, 0.9, 0, null, null); // matched to Dana
    old.exec("PRAGMA user_version = 17");
    old.close();

    const store = new Store(path);
    const you = store.db.prepare("SELECT embedding, weight FROM voices WHERE name = 'You'").get() as { embedding: Uint8Array; weight: number };
    expect([...new Float32Array(new Uint8Array(you.embedding).buffer)]).toEqual([0, 0]);
    expect(you.weight).toBe(0);
    const speakers = store.db.prepare("SELECT id, voice_id, confirmed, named_weight FROM call_speakers ORDER BY id").all();
    expect(speakers.map((row) => ({ ...row }))).toEqual([
      { id: 1, voice_id: 1, confirmed: 1, named_weight: null },
      { id: 2, voice_id: 1, confirmed: 0, named_weight: null },
      { id: 3, voice_id: 2, confirmed: 0, named_weight: null },
    ]);
    expect(store.db.prepare("SELECT weight FROM voices WHERE name = 'Dana'").get()).toEqual({ weight: 3 });
    expect(store.db.prepare("SELECT count(*) AS n FROM recordings WHERE your_voice_learned_at IS NOT NULL").get()).toEqual({ n: 0 });
    store.close();
  });

  it("should drop an unconfirmed You voice when adding per-call shares, unmatching its speakers", () => {
    const path = join(dir, "a.db");
    const old = new DatabaseSync(path);
    MIGRATIONS.slice(0, 17).forEach((migration) => old.exec(migration));
    const now = "2026-11-10T12:00:00.000Z";
    const print = new Uint8Array(new Float32Array([0.6, 0.8]).buffer);
    old.exec(`INSERT INTO recordings (id, started_at, folder) VALUES (1, '${now}', '/r')`);
    old.prepare("INSERT INTO voices (id, name, embedding, weight, created_at, updated_at) VALUES (1, 'You', ?, 40, ?, ?)").run(print, now, now);
    old.prepare("INSERT INTO call_speakers (id, recording_id, number, embedding, weight, voice_id, voice_score) VALUES (1, 1, 1, ?, 1, 1, 0.9)").run(print);
    old.exec("PRAGMA user_version = 17");
    old.close();

    const store = new Store(path);
    expect(store.db.prepare("SELECT count(*) AS n FROM voices").get()).toEqual({ n: 0 });
    expect({ ...(store.db.prepare("SELECT voice_id, voice_score FROM call_speakers").get() as object) }).toEqual({ voice_id: null, voice_score: null });
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
