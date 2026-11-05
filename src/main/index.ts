import { join } from "node:path";
import { app, desktopCapturer, powerMonitor, shell, systemPreferences } from "electron";
import { BackupScheduler } from "./backup/BackupScheduler";
import { BackupService } from "./backup/BackupService";
import { S3ObjectStorage } from "./backup/ObjectStorage";
import { registerIpcHandlers } from "./ipcHandlers";
import { Permissions, runAppleScript } from "./permissions/Permissions";
import { Store } from "./store/Store";
import { TrayController } from "./TrayController";
import { WindowManager, type Screen } from "./WindowManager";

/** How long quitting waits for a backup in progress before giving up on it. */
const QUIT_WAIT_MS = 30_000;

void main();

/**
 * Starts the tray app: one instance only, no Dock icon, the database opened and migrated, the weekly
 * backup scheduled, and the permissions screen shown if macOS still needs to grant anything.
 */
async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  app.dock?.hide();

  const store = new Store(join(app.getPath("userData"), "time-center.db"));
  const permissions = createPermissions();
  const windows = new WindowManager();
  const backupService = new BackupService(
    store,
    (settings) => new S3ObjectStorage(settings.bucket, settings.region, settings.profile),
  );
  const backupState = { lastError: null as string | null };
  const tray = new TrayController({ backupService, windows, onBackupNow: () => scheduler.runNow() });
  const scheduler = new BackupScheduler(backupService, (result) => {
    backupState.lastError = result.ok ? null : result.error;
    tray.refresh(backupState.lastError);
  });

  registerIpcHandlers({
    store,
    permissions,
    backupService,
    scheduler,
    backupState,
    onBackupChanged: () => tray.refresh(backupState.lastError),
  });
  tray.create();
  scheduler.start();
  powerMonitor.on("resume", () => {
    void scheduler.checkNow();
  });

  app.on("second-instance", (_event, argv) => windows.show(screenFromArgs(argv)));
  app.on("window-all-closed", () => {
    // A tray app keeps running with no windows open.
  });
  app.on("before-quit", (event) => {
    scheduler.stop();
    if (scheduler.isRunning()) {
      // Closing the database under a running backup would leave it half-recorded, so wait for it.
      event.preventDefault();
      void waitAtMost(scheduler.whenIdle(), QUIT_WAIT_MS).then(() => {
        store.close();
        app.exit(0);
      });
      return;
    }
    store.close();
  });

  if (permissions.needsAttention()) {
    windows.show("permissions");
  }
}

/**
 * Wires the permissions logic to Electron's real macOS APIs.
 * @returns The permissions service.
 */
function createPermissions(): Permissions {
  return new Permissions({
    isTrustedAccessibilityClient: (prompt) => systemPreferences.isTrustedAccessibilityClient(prompt),
    getMediaAccessStatus: (mediaType) => systemPreferences.getMediaAccessStatus(mediaType),
    askForMediaAccess: (mediaType) => systemPreferences.askForMediaAccess(mediaType),
    // Trying to capture once is what makes macOS list the app under Screen Recording and show its prompt.
    requestScreenCapture: async () => {
      await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    },
    openExternal: (url) => shell.openExternal(url),
    runAppleScript,
  });
}

/**
 * Picks the screen a second launch asked for with `--open=permissions`; Settings otherwise.
 * @param argv The second instance's command line.
 * @returns The screen to show.
 */
function screenFromArgs(argv: string[]): Screen {
  return argv.includes("--open=permissions") ? "permissions" : "settings";
}

/**
 * Waits for a promise, but no longer than a time limit.
 * @param promise What to wait for.
 * @param ms The limit.
 */
async function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([promise, limit]);
  clearTimeout(timer);
}
