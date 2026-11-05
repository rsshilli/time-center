import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";

/** The files SQLite may keep beside a database. They belong to it and move with it. */
const COMPANION_SUFFIXES = ["", "-wal", "-shm", "-journal"];

/**
 * Puts a restored database in place of the live one. The live database (with its WAL companions) is
 * kept beside it, renamed, so a restore can always be undone by hand. The live database must be closed
 * first.
 * @param livePath The app's database file.
 * @param restoredPath A checked, self-contained restored file (see BackupService.restoreBackup).
 * @param stamp Added to the kept copy's name, e.g. "2026-11-04T18-00-00Z".
 * @returns Where the previous database was kept.
 */
export async function swapInRestoredDatabase(livePath: string, restoredPath: string, stamp: string): Promise<string> {
  if (!existsSync(restoredPath)) {
    throw new Error(`The restored database is missing: ${restoredPath}`);
  }
  const keptPath = `${livePath}.before-restore-${stamp}`;
  for (const suffix of COMPANION_SUFFIXES) {
    if (existsSync(`${livePath}${suffix}`)) {
      await rename(`${livePath}${suffix}`, `${keptPath}${suffix}`);
    }
  }
  await rename(restoredPath, livePath);
  return keptPath;
}
