import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { swapInRestoredDatabase } from "../../src/main/backup/swapDatabase";

describe("swapInRestoredDatabase", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tc-swap-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("should put the restored file in place and keep the old database and its WAL files beside it", async () => {
    const live = join(dir, "time-center.db");
    await writeFile(live, "old");
    await writeFile(`${live}-wal`, "old-wal");
    await writeFile(`${live}-shm`, "old-shm");
    await writeFile(join(dir, "restored.db"), "new");

    const kept = await swapInRestoredDatabase(live, join(dir, "restored.db"), "2026-11-04T18-00-00Z");

    expect(await readFile(live, "utf8")).toBe("new");
    expect(await readFile(kept, "utf8")).toBe("old");
    expect(await readFile(`${kept}-wal`, "utf8")).toBe("old-wal");
    expect((await readdir(dir)).sort()).toEqual([
      "time-center.db",
      "time-center.db.before-restore-2026-11-04T18-00-00Z",
      "time-center.db.before-restore-2026-11-04T18-00-00Z-shm",
      "time-center.db.before-restore-2026-11-04T18-00-00Z-wal",
    ]);
  });

  it("should leave the live database alone when the restored file is missing", async () => {
    const live = join(dir, "time-center.db");
    await writeFile(live, "old");

    await expect(swapInRestoredDatabase(live, join(dir, "missing.db"), "x")).rejects.toThrow(/missing/);
    expect(await readFile(live, "utf8")).toBe("old");
  });
});
