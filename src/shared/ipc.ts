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

/** What a category rule looks at. */
export type RuleField = "app" | "domain" | "url" | "title" | "project";

/**
 * Puts matching time in a category. Matching ignores case: "domain" matches the site or any of its
 * subdomains, every other field matches when it contains the pattern. The first matching rule wins.
 */
export interface CategoryRule {
  field: RuleField;
  pattern: string;
  category: string;
}

/** What kind of time a stretch was: working in an app, away from the keyboard, or an ignored app. */
export type SegmentKind = "active" | "idle" | "untracked";

/** One stretch of the day's timeline, clipped to the day. Times are milliseconds since 1970. */
export interface TimelineItem {
  start: number;
  end: number;
  kind: SegmentKind;
  category: string;
  app: string | null;
  title: string | null;
  url: string | null;
  domain: string | null;
  project: string | null;
}

/** One minute's screenshot of one display, or a minute skipped because the CPU was busy. */
export interface ScreenshotInfo {
  id: number;
  takenAt: number;
  status: "taken" | "skipped-busy";
  displayId: string | null;
}

/** A name and how many milliseconds went to it. */
export interface Total {
  name: string;
  ms: number;
}

/** Everything the dashboard shows for one day. */
export interface DayReport {
  /** Local midnight that starts the day, in milliseconds since 1970. */
  dayStart: number;
  dayEnd: number;
  timeline: TimelineItem[];
  screenshots: ScreenshotInfo[];
  activeMs: number;
  idleMs: number;
  untrackedMs: number;
  byCategory: Total[];
  byApp: Total[];
  byProject: Total[];
  byDomain: Total[];
}

/** The custom URL scheme the dashboard loads screenshots from. */
export const SCREENSHOT_SCHEME = "time-center-shot";

/**
 * Builds a screenshot's URL. The id goes in the path: Chromium rewrites a numeric host such as "6" to
 * the IP address "0.0.0.6" for standard schemes, so `time-center-shot://6/thumb` would never match.
 * @param id The screenshot's id.
 * @param size The thumbnail or the full picture.
 * @returns e.g. "time-center-shot://shot/6/thumb".
 */
export function screenshotUrl(id: number, size: "thumb" | "full"): string {
  return `${SCREENSHOT_SCHEME}://shot/${id}/${size}`;
}

/** IPC channel names shared by the main process and the preload bridge. */
export const IPC = {
  getDay: "activity:get-day",
  getRules: "rules:get",
  saveRules: "rules:save",
  getIgnoredApps: "ignored-apps:get",
  saveIgnoredApps: "ignored-apps:save",
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
  /** The timeline, screenshots and totals for the local day that contains this moment. */
  getDay(at: number): Promise<DayReport>;
  /** The category rules, in the order they are tried. */
  getRules(): Promise<CategoryRule[]>;
  /** Replaces the category rules. They apply to past days too, since categories are worked out on read. */
  saveRules(rules: CategoryRule[]): Promise<CategoryRule[]>;
  /** Apps never recorded or photographed: bundle ids (covering the ids under them) or app names. */
  getIgnoredApps(): Promise<string[]>;
  /** Replaces the ignored apps; takes effect within a few seconds. Returns the cleaned list. */
  saveIgnoredApps(apps: string[]): Promise<string[]>;
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
