import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityStore, type NewScreenshot } from "../../src/main/activity/ActivityStore";
import { cleanUpScreenshots } from "../../src/main/screenshots/cleanUpScreenshots";
import { Store } from "../../src/main/store/Store";

describe("cleanUpScreenshots", () => {
  let dir: string;
  let store: Store;
  let activity: ActivityStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tc-clean-"));
    store = new Store(":memory:");
    activity = new ActivityStore(store.db);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("should delete day folders and rows older than 30 days and keep the rest", async () => {
    const now = new Date(2026, 10, 4, 12).getTime();
    for (const name of ["2026-10-04", "2026-10-05", "2026-11-04", "notes"]) {
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, "a.jpg"), "x");
    }
    activity.insertScreenshot(shot(new Date(2026, 9, 4, 23).getTime()));
    activity.insertScreenshot(shot(new Date(2026, 9, 5, 1).getTime()));

    expect(await cleanUpScreenshots(dir, activity, now)).toBe(1);

    expect((await readdir(dir)).sort()).toEqual(["2026-10-05", "2026-11-04", "notes"]);
    expect(activity.listScreenshots(0, Date.UTC(3000, 0, 1))).toHaveLength(1);
  });

  it("should do nothing when the folder doesn't exist yet", async () => {
    expect(await cleanUpScreenshots(join(dir, "missing"), activity, Date.now())).toBe(0);
  });
});

/**
 * A screenshot row taken at a moment.
 * @param takenAt The moment.
 * @returns The row.
 */
function shot(takenAt: number): NewScreenshot {
  return {
    takenAt,
    status: "taken",
    displayId: "1",
    path: null,
    thumbPath: null,
    bytes: 1,
    cpuPercent: 1,
    segmentId: null,
  };
}
