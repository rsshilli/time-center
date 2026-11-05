import { Menu, Tray, app, nativeImage } from "electron";
import type { BackupService } from "./backup/BackupService";
import type { WindowManager } from "./WindowManager";

/** What the tray needs from the rest of the app. */
export interface TrayDependencies {
  backupService: BackupService;
  windows: WindowManager;
  onBackupNow: () => Promise<void>;
}

/** The text shown in the menu bar. A symbol for now; later phases add a red dot while recording. */
const TRAY_TITLE = "◷";

/**
 * The menu-bar icon and its menu: open the app's screens, see when the last backup ran, back up now,
 * and quit. The menu is rebuilt whenever the backup state changes.
 */
export class TrayController {
  private tray: Tray | null = null;

  /** @param deps The services the menu acts on. */
  constructor(private readonly deps: TrayDependencies) {}

  /** Puts the icon in the menu bar. */
  create(): void {
    this.tray = new Tray(nativeImage.createEmpty());
    this.tray.setTitle(TRAY_TITLE);
    this.tray.setToolTip("Time Center");
    this.refresh(null);
  }

  /**
   * Rebuilds the menu with the current backup line.
   * @param lastError The most recent backup error, or null when the last attempt worked.
   */
  refresh(lastError: string | null): void {
    if (!this.tray) {
      return;
    }
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Settings…", click: () => this.deps.windows.show("settings") },
        { label: "Permissions…", click: () => this.deps.windows.show("permissions") },
        { type: "separator" },
        { label: describeBackup(this.deps.backupService, lastError), enabled: false },
        {
          label: "Back up now",
          enabled: this.deps.backupService.getSettings() !== null,
          click: () => {
            void this.deps.onBackupNow();
          },
        },
        { type: "separator" },
        { label: "Quit Time Center", click: () => app.quit() },
      ]),
    );
  }
}

/**
 * Writes the one-line backup status shown in the menu.
 * @param service The backup service.
 * @param lastError The latest error, if the last attempt failed.
 * @returns e.g. "Last backup: Nov 4, 6:00 PM" or "Backup: not set up".
 */
export function describeBackup(service: BackupService, lastError: string | null): string {
  if (!service.getSettings()) {
    return "Backup: not set up";
  }
  if (lastError) {
    return `Backup failed: ${lastError.slice(0, 60)}`;
  }
  const lastSuccessAt = service.getLastSuccessAt();
  if (!lastSuccessAt) {
    return "Last backup: never";
  }
  const when = new Date(lastSuccessAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Last backup: ${when}`;
}
