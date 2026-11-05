/** The macOS permissions the app needs, in the order the onboarding screen shows them. */
export type PermissionKind = "accessibility" | "screen" | "microphone" | "automation";

/**
 * What macOS says about one permission. "unknown" is for Automation, which macOS only reports when the
 * app actually tries to talk to Chrome.
 */
export type PermissionState = "granted" | "denied" | "not-determined" | "unknown";

/** One row on the permissions screen. */
export interface PermissionStatus {
  kind: PermissionKind;
  state: PermissionState;
}

/** What the settings screen shows about backups. */
export interface BackupStatus {
  configured: boolean;
  bucket: string;
  region: string;
  profile: string;
  kmsKeyId: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  running: boolean;
}

/** The backup fields the user can edit. Empty strings mean "use the default" (or "off" for the bucket). */
export interface BackupSettingsInput {
  bucket: string;
  region: string;
  profile: string;
  kmsKeyId: string;
}

/** How a restore request ended, when the app didn't restart onto the restored data. */
export type RestoreResult = { status: "restored" } | { status: "cancelled" } | { status: "failed"; error: string };

/** IPC channel names shared by the main process and the preload bridge. */
export const IPC = {
  getPermissions: "permissions:get",
  requestPermission: "permissions:request",
  openPermissionSettings: "permissions:open-settings",
  getBackupStatus: "backup:status",
  saveBackupSettings: "backup:save-settings",
  runBackupNow: "backup:run-now",
  restoreLatestBackup: "backup:restore-latest",
} as const;

/** The API the preload script exposes to the renderer as `window.timeCenter`. */
export interface TimeCenterApi {
  /** Every permission's current state. */
  getPermissions(): Promise<PermissionStatus[]>;
  /** Shows macOS's prompt for a permission (or its Settings pane) and returns the new states. */
  requestPermission(kind: PermissionKind): Promise<PermissionStatus[]>;
  /** Opens System Settings at a permission's pane. */
  openPermissionSettings(kind: PermissionKind): Promise<void>;
  /** The backup destination and when the last backup ran. */
  getBackupStatus(): Promise<BackupStatus>;
  /** Saves the backup destination and backs up straight away if one is due. */
  saveBackupSettings(input: BackupSettingsInput): Promise<BackupStatus>;
  /** Backs up now and resolves when the backup (or the one already running) has finished. */
  runBackupNow(): Promise<BackupStatus>;
  /** Asks, then replaces this Mac's data with the newest backup and restarts the app. */
  restoreLatestBackup(): Promise<RestoreResult>;
}
