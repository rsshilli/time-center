import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ActivityStore } from "../activity/ActivityStore";
import { localStamp } from "./ScreenCapturer";

/** Screenshots are kept this many days, then deleted (user's pick). */
export const RETENTION_DAYS = 30;

/** Day folders are named YYYY-MM-DD; anything else in the folder is left alone. */
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Deletes screenshots older than the retention period: whole day folders older than the cut-off day,
 * and their rows in the database.
 * @param screenshotsDir The folder holding one sub-folder per day.
 * @param activity The screenshots table.
 * @param now The current time.
 * @returns How many day folders were deleted.
 */
export async function cleanUpScreenshots(
  screenshotsDir: string,
  activity: Pick<ActivityStore, "deleteScreenshotsBefore">,
  now: number,
): Promise<number> {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffDay = localStamp(cutoff.getTime()).day;
  activity.deleteScreenshotsBefore(cutoff.getTime());

  let folders: string[];
  try {
    folders = await readdir(screenshotsDir);
  } catch {
    return 0;
  }
  const old = folders.filter((name) => DAY_FOLDER.test(name) && name < cutoffDay);
  for (const name of old) {
    await rm(join(screenshotsDir, name), { recursive: true, force: true });
  }
  return old.length;
}
