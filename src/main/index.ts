import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Notification,
  app,
  desktopCapturer,
  dialog,
  powerMonitor,
  safeStorage,
  shell,
  systemPreferences,
} from "electron";
import { CalendarClient } from "./calendar/CalendarClient";
import { CalendarStore } from "./calendar/CalendarStore";
import { CalendarSync } from "./calendar/CalendarSync";
import { isAutoJoinOn, registerCalendarIpc } from "./calendar/calendarIpc";
import { installExtensionCopy } from "./calendar/extensionFolder";
import { GoogleAuth, builtInGoogleClient } from "./calendar/GoogleAuth";
import { JoinScheduler, type Notice } from "./calendar/JoinScheduler";
import { MeetingJoiner, openInChrome } from "./calendar/MeetingJoiner";
import { extensionKey, signMarker } from "./calendar/markerSigner";
import type { CalendarEvent } from "./calendar/meetingLinks";
import { ActivityStore } from "./activity/ActivityStore";
import { ActivityTracker, SAMPLE_INTERVAL_SECONDS } from "./activity/ActivityTracker";
import { SegmentRecorder } from "./activity/SegmentRecorder";
import { IGNORED_APPS_SETTING, parseIgnoredApps } from "./activity/ignoredApps";
import { startWindowHelper } from "./activity/windowHelper";
import { BackupScheduler } from "./backup/BackupScheduler";
import { BackupService } from "./backup/BackupService";
import { S3ObjectStorage } from "./backup/ObjectStorage";
import { registerIpcHandlers } from "./ipcHandlers";
import { Permissions, runAppleScript } from "./permissions/Permissions";
import { cleanUpScreenshots } from "./screenshots/cleanUpScreenshots";
import { captureDisplays, sampleCpuPercent } from "./screenshots/platform";
import { ScreenCapturer } from "./screenshots/ScreenCapturer";
import { handleScreenshotScheme, registerScreenshotScheme } from "./screenshots/screenshotProtocol";
import { SecretStore } from "./store/SecretStore";
import { Store } from "./store/Store";
import { TrayController } from "./TrayController";
import { WindowManager, type Screen } from "./WindowManager";

/** How long quitting waits for a backup in progress before giving up on it. */
const QUIT_WAIT_MS = 30_000;

/** How often old screenshots are cleared out. */
const CLEAN_UP_EVERY_MS = 24 * 60 * 60_000;

void main();

/**
 * Starts the tray app: one instance only, no Dock icon, the database opened and migrated, activity
 * tracking and minute screenshots running, the weekly backup scheduled, and the permissions screen
 * shown if macOS still needs to grant anything.
 */
async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  registerScreenshotScheme();
  await app.whenReady();
  app.dock?.hide();

  const store = new Store(join(app.getPath("userData"), "time-center.db"));
  const activity = new ActivityStore(store.db);
  /** The ignored-apps list as saved in Settings, read fresh each time it's needed. */
  const ignoredApps = () => parseIgnoredApps(store.getSetting(IGNORED_APPS_SETTING));
  const tracker = createTracker(activity, ignoredApps);
  const screenshotsDir = join(app.getPath("userData"), "screenshots");
  const capturer = new ScreenCapturer({
    activity,
    currentSegment: () => tracker.current(),
    canCapture: () => systemPreferences.getMediaAccessStatus("screen") === "granted",
    sampleCpuPercent,
    captureDisplays: () => captureDisplays(helperPath(), ignoredApps()),
    screenshotsDir,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const permissions = createPermissions();
  const windows = new WindowManager();
  const backupService = new BackupService(
    store,
    (settings) => new S3ObjectStorage(settings.bucket, settings.region, settings.profile),
  );
  const backupState = { lastError: null as string | null };
  const calendar = createCalendar(store, () => tray.refresh());
  const tray = new TrayController({
    backupService,
    windows,
    onBackupNow: () => scheduler.runNow(),
    meetings: () => ({
      signedIn: calendar.auth.isSignedIn(),
      list: calendar.auth.isSignedIn() ? calendar.joins.meetings() : [],
    }),
    onSkipMeeting: (eventId) => calendar.joins.skip(eventId),
    onJoinMeeting: (eventId) => {
      calendar.joins.joinNow(eventId).catch((error: unknown) => showJoinFailure(String(error)));
    },
  });
  const scheduler = new BackupScheduler(backupService, (result) => {
    backupState.lastError = result.ok ? null : result.error;
    tray.refresh(backupState.lastError);
  });

  registerIpcHandlers({
    store,
    activity,
    permissions,
    backupService,
    scheduler,
    backupState,
    onBackupChanged: () => tray.refresh(backupState.lastError),
    onIgnoredAppsChanged: () => tracker.restart(),
  });
  const extensionPath = join(app.getPath("userData"), "chrome-extension");
  registerCalendarIpc({
    auth: calendar.auth,
    sync: calendar.sync,
    scheduler: calendar.joins,
    settings: store,
    extensionPath,
    pickClientFile: async () => {
      const picked = await dialog.showOpenDialog({
        title: "Choose the Google client file (credentials.json)",
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      return picked.canceled || !picked.filePaths[0] ? null : readFile(picked.filePaths[0], "utf8");
    },
    showFolder: async (path) => shell.showItemInFolder(join(path, "manifest.json")),
    onChange: () => tray.refresh(),
  });
  installExtensionCopy(extensionSourcePath(), extensionPath, extensionKey(store)).catch((error: unknown) => {
    console.error("Time Center: couldn't copy the Chrome extension", error);
  });
  handleScreenshotScheme(activity);
  tray.create();
  scheduler.start();
  tracker.start();
  capturer.start();
  calendar.sync.start();
  calendar.joins.start();
  // Keeps "Next: …" current as meetings start and end between syncs.
  setInterval(() => tray.refresh(), 60_000);
  /** Deletes screenshots past the 30-day retention, logging rather than crashing on a failure. */
  const cleanUp = () => {
    cleanUpScreenshots(screenshotsDir, activity, Date.now()).catch((error: unknown) => {
      console.error("Time Center: screenshot clean-up failed", error);
    });
  };
  cleanUp();
  setInterval(cleanUp, CLEAN_UP_EVERY_MS);

  powerMonitor.on("suspend", () => tracker.pause("asleep"));
  powerMonitor.on("lock-screen", () => tracker.pause("locked"));
  powerMonitor.on("unlock-screen", () => tracker.resume("locked"));
  powerMonitor.on("resume", () => {
    tracker.resume("asleep");
    void scheduler.checkNow();
    void calendar.sync.syncNow();
  });
  systemPreferences.subscribeNotification("com.apple.screensaver.didstart", () => tracker.pause("screen saver"));
  systemPreferences.subscribeNotification("com.apple.screensaver.didstop", () => tracker.resume("screen saver"));

  app.on("second-instance", (_event, argv) => windows.show(screenFromArgs(argv)));
  app.on("window-all-closed", () => {
    // A tray app keeps running with no windows open.
  });
  app.on("before-quit", (event) => {
    calendar.joins.stop();
    calendar.sync.stop();
    capturer.stop();
    tracker.stop();
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
 * Builds the activity tracker on the Swift front-window helper and macOS's idle timer.
 * @param activity The activity tables.
 * @param ignoredApps Reads the current ignored-apps list; each helper start picks up the latest.
 * @returns The tracker, not yet started.
 */
function createTracker(activity: ActivityStore, ignoredApps: () => string[]): ActivityTracker {
  return new ActivityTracker({
    recorder: new SegmentRecorder(activity),
    startHelper: (onSample, onExit) =>
      startWindowHelper(helperPath(), SAMPLE_INTERVAL_SECONDS, ignoredApps(), onSample, onExit),
    getIdleMs: () => powerMonitor.getSystemIdleTime() * 1000,
    now: () => Date.now(),
  });
}

/**
 * Builds the calendar side: Google sign-in (the client built into the app, the refresh token kept with
 * the Keychain key), the five-minute sync of the main calendar, and the join timer with its notices.
 * @param store The database.
 * @param onChange Called when a meeting's state or the sign-in changes, to refresh the tray.
 * @returns The sign-in, the sync and the join timer, not yet started.
 */
function createCalendar(store: Store, onChange: () => void) {
  const auth = new GoogleAuth({
    secrets: new SecretStore(store, safeStorage),
    builtInClient: builtInGoogleClient(),
    openExternal: (url) => shell.openExternal(url),
    fetch,
    now: () => Date.now(),
  });
  const calendarStore = new CalendarStore(store.db);
  const sync = new CalendarSync({
    client: new CalendarClient(() => auth.getAccessToken(), fetch),
    calendar: calendarStore,
    settings: store,
    isSignedIn: () => auth.isSignedIn(),
    onSynced: () => {
      joins.tick();
      onChange();
    },
    now: () => Date.now(),
  });
  const joiner = new MeetingJoiner({
    openExternal: (url) => shell.openExternal(url),
    openInChrome,
    account: () => sync.account(),
    signMarker: (url) => signMarker(extensionKey(store), url, Date.now()),
  });
  const joins: JoinScheduler = new JoinScheduler({
    calendar: calendarStore,
    autoJoin: () => auth.isSignedIn() && isAutoJoinOn(store),
    notify: showJoinNotice,
    join: (event) => joiner.join(event),
    reportFailure: (event, error) => showJoinFailure(`${event.title}: ${error}`),
    onChange,
    now: () => Date.now(),
  });
  return { auth, sync, joins };
}

/**
 * Shows the macOS notice that a meeting is about to be joined; clicking it skips the join.
 * @param event The meeting.
 * @param joinAt When it will be joined.
 * @param onSkip Skips the join.
 * @returns A handle that takes the notice down.
 */
function showJoinNotice(event: CalendarEvent, joinAt: number, onSkip: () => void): Notice {
  const seconds = Math.max(1, Math.round((joinAt - Date.now()) / 1000));
  // The title comes from whoever sent the invitation, so it goes in the body, cut short, not the headline.
  const title = event.title.length > 80 ? `${event.title.slice(0, 79)}…` : event.title;
  const notice = new Notification({
    title: `Joining a meeting in ${seconds} s — click to skip`,
    body: title,
  });
  notice.on("click", onSkip);
  notice.show();
  return { close: () => notice.close() };
}

/**
 * Tells the user a meeting couldn't be opened.
 * @param message What went wrong.
 */
function showJoinFailure(message: string): void {
  new Notification({ title: "Couldn't join the meeting", body: message.replace(/^Error: /, "") }).show();
}

/**
 * Finds the Chrome extension shipped with the app.
 * @returns Contents/Resources/extension when packaged; the repo's extension folder in dev.
 */
function extensionSourcePath(): string {
  return app.isPackaged ? join(process.resourcesPath, "extension") : join(app.getAppPath(), "extension");
}

/**
 * Finds the compiled Swift helper.
 * @returns Contents/Resources/bin in the packaged app (electron-builder extraResources); in dev, the
 *   copy built by `npm run native`.
 */
function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "bin/active-window")
    : join(app.getAppPath(), "resources/bin/active-window");
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
 * Picks the screen a second launch asked for with `--open=permissions` or `--open=settings`; the
 * dashboard otherwise.
 * @param argv The second instance's command line.
 * @returns The screen to show.
 */
function screenFromArgs(argv: string[]): Screen {
  if (argv.includes("--open=permissions")) {
    return "permissions";
  }
  return argv.includes("--open=settings") ? "settings" : "dashboard";
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
