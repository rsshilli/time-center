import { ipcMain } from "electron";
import { IPC, type BackupSettingsInput, type BackupStatus, type PermissionKind } from "../shared/ipc";
import type { ActivityStore } from "./activity/ActivityStore";
import { assertRules, parseRules } from "./activity/classify";
import { buildDayReport } from "./activity/dayReport";
import { IGNORED_APPS_SETTING, assertIgnoredApps, parseIgnoredApps } from "./activity/ignoredApps";
import type { BackupScheduler } from "./backup/BackupScheduler";
import type { BackupService } from "./backup/BackupService";
import type { CalendarStore } from "./calendar/CalendarStore";
import type { Permissions } from "./permissions/Permissions";
import { restoreLatestBackup } from "./restoreLatestBackup";
import type { Store } from "./store/Store";

/** The services the renderer's requests are answered from. */
export interface IpcDependencies {
  store: Store;
  activity: ActivityStore;
  /** The calendar's meetings, whose types split the day's meeting time. */
  calendar: Pick<CalendarStore, "listTypedEvents">;
  permissions: Permissions;
  backupService: BackupService;
  scheduler: BackupScheduler;
  backupState: { lastError: string | null };
  onBackupChanged: () => void;
  /** Restarts the window helper so a new ignored-apps list takes effect. */
  onIgnoredAppsChanged: () => void;
}

/** The setting that holds the category rules as JSON. */
export const RULES_SETTING = "categoryRules";

/** Permission names the renderer may send; anything else is rejected. */
const PERMISSION_KINDS: readonly PermissionKind[] = ["accessibility", "screen", "microphone", "automation"];

/**
 * Answers the renderer's requests over IPC. Every handler checks its input, because the renderer is
 * treated as untrusted.
 * @param deps The services to answer from.
 */
export function registerIpcHandlers(deps: IpcDependencies): void {
  ipcMain.handle(IPC.getDay, (_event, at: unknown) =>
    buildDayReport(deps.activity, parseRules(deps.store.getSetting(RULES_SETTING)), assertMoment(at), (from, to) =>
      deps.calendar.listTypedEvents(from, to),
    ),
  );
  ipcMain.handle(IPC.getRules, () => parseRules(deps.store.getSetting(RULES_SETTING)));
  ipcMain.handle(IPC.saveRules, (_event, rules: unknown) => {
    const checked = assertRules(rules);
    deps.store.setSetting(RULES_SETTING, JSON.stringify(checked));
    return checked;
  });
  ipcMain.handle(IPC.getIgnoredApps, () => parseIgnoredApps(deps.store.getSetting(IGNORED_APPS_SETTING)));
  ipcMain.handle(IPC.saveIgnoredApps, (_event, apps: unknown) => {
    const checked = assertIgnoredApps(apps);
    deps.store.setSetting(IGNORED_APPS_SETTING, JSON.stringify(checked));
    deps.onIgnoredAppsChanged();
    return checked;
  });
  ipcMain.handle(IPC.getPermissions, () => deps.permissions.getAll());
  ipcMain.handle(IPC.requestPermission, (_event, kind: unknown) => deps.permissions.request(assertPermissionKind(kind)));
  ipcMain.handle(IPC.openPermissionSettings, (_event, kind: unknown) =>
    deps.permissions.openSettings(assertPermissionKind(kind)),
  );
  ipcMain.handle(IPC.getBackupStatus, () => buildBackupStatus(deps));
  ipcMain.handle(IPC.saveBackupSettings, (_event, input: unknown) => {
    deps.backupService.saveSettings(assertBackupSettingsInput(input));
    deps.backupState.lastError = null;
    deps.onBackupChanged();
    void deps.scheduler.checkNow();
    return buildBackupStatus(deps);
  });
  ipcMain.handle(IPC.runBackupNow, async () => {
    await deps.scheduler.runNow();
    return buildBackupStatus(deps);
  });
  ipcMain.handle(IPC.restoreLatestBackup, () => restoreLatestBackup(deps));
}

/**
 * Checks that a value from the renderer is a usable moment in time.
 * @param at The value, milliseconds since 1970.
 * @returns It, typed.
 */
export function assertMoment(at: unknown): number {
  if (typeof at !== "number" || !Number.isFinite(at) || Number.isNaN(new Date(at).getTime())) {
    throw new Error(`Not a moment in time: ${String(at)}`);
  }
  return at;
}

/**
 * Checks that a value from the renderer names a known permission.
 * @param kind The value.
 * @returns It, typed.
 */
export function assertPermissionKind(kind: unknown): PermissionKind {
  if (typeof kind !== "string" || !PERMISSION_KINDS.includes(kind as PermissionKind)) {
    throw new Error(`Unknown permission: ${String(kind)}`);
  }
  return kind as PermissionKind;
}

/**
 * Collects what the settings screen shows about backups.
 * @param deps The services.
 * @returns The status.
 */
function buildBackupStatus(deps: IpcDependencies): BackupStatus {
  const settings = deps.backupService.getSettings();
  return {
    configured: settings !== null,
    bucket: settings?.bucket ?? "",
    region: settings?.region ?? "us-east-1",
    profile: settings?.profile ?? "default",
    kmsKeyId: settings?.kmsKeyId ?? "",
    lastSuccessAt: deps.backupService.getLastSuccessAt(),
    lastError: deps.backupState.lastError,
    running: deps.scheduler.isRunning(),
  };
}

/**
 * Checks that a value from the renderer is a complete set of backup fields, all strings.
 * @param input The value.
 * @returns It, typed.
 */
export function assertBackupSettingsInput(input: unknown): BackupSettingsInput {
  const candidate = input as Record<string, unknown> | null;
  const fields = ["bucket", "region", "profile", "kmsKeyId"] as const;
  if (!candidate || typeof candidate !== "object" || fields.some((field) => typeof candidate[field] !== "string")) {
    throw new Error("Backup settings must include bucket, region, profile and kmsKeyId as text.");
  }
  return {
    bucket: candidate.bucket as string,
    region: candidate.region as string,
    profile: candidate.profile as string,
    kmsKeyId: candidate.kmsKeyId as string,
  };
}
