import { basename } from "node:path";
import { app, dialog } from "electron";
import type { RestoreResult } from "../shared/ipc";
import type { BackupScheduler } from "./backup/BackupScheduler";
import type { BackupService } from "./backup/BackupService";
import { swapInRestoredDatabase } from "./backup/swapDatabase";
import type { Store } from "./store/Store";

/** What the restore needs from the rest of the app. */
export interface RestoreDependencies {
  store: Store;
  backupService: BackupService;
  scheduler: BackupScheduler;
}

/**
 * Replaces this Mac's database with the newest backup in S3, after the user confirms. The backup is
 * downloaded and checked first, the current database is kept beside it under a "before-restore" name,
 * and the app relaunches onto the restored data. On success this never returns: the app restarts.
 * @param deps The store, backup service and scheduler.
 * @returns Why nothing was restored, when the user cancelled or something failed.
 */
export async function restoreLatestBackup(deps: RestoreDependencies): Promise<RestoreResult> {
  if (deps.scheduler.isRunning()) {
    return { status: "failed", error: "A backup is running right now. Try again when it finishes." };
  }
  const [latestKey] = await deps.backupService.listBackups();
  if (!latestKey) {
    return { status: "failed", error: "There are no backups in the bucket yet." };
  }
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: "Restore the latest backup?",
    detail:
      `This replaces Time Center's data on this Mac with ${basename(latestKey)}. ` +
      "Your current data is kept in the same folder with \"before-restore\" in its name. Time Center restarts afterwards.",
    buttons: ["Restore", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) {
    return { status: "cancelled" };
  }

  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  const restoredPath = `${deps.store.dbPath}.restored-${stamp}`;
  await deps.backupService.restoreBackup(latestKey, restoredPath);
  deps.scheduler.stop();
  await deps.scheduler.whenIdle();
  deps.store.close();
  try {
    await swapInRestoredDatabase(deps.store.dbPath, restoredPath, stamp);
  } finally {
    // The database is closed either way, so the app can't carry on; it restarts onto whatever is in place.
    app.relaunch();
    app.exit(0);
  }
  return { status: "restored" };
}
