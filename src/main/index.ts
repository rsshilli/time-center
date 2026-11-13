import { execFile } from "node:child_process";
import { readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
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
import { readJoinMode, registerCalendarIpc } from "./calendar/calendarIpc";
import { GoogleAuth, builtInGoogleClient } from "./calendar/GoogleAuth";
import { JoinScheduler, type Notice } from "./calendar/JoinScheduler";
import { MeetingJoiner, openInChrome } from "./calendar/MeetingJoiner";
import { BEDROCK_SONNET_MODEL, BedrockHaiku } from "./calendar/BedrockHaiku";
import { MeetingTyper } from "./calendar/MeetingTyper";
import { registerMeetingTypeIpc } from "./calendar/meetingTypeIpc";
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
import { Permissions, readAutomationStatus, runAppleScript } from "./permissions/Permissions";
import { RecordingController } from "./recording/RecordingController";
import { mixLeftoverSides, startRecorder } from "./recording/recorderProcess";
import {
  cleanUpRecordings,
  countUnreadChunks,
  nameRecordingAudio,
  recoverRecordings,
} from "./recording/recordingFiles";
import { bestMeeting, isSoloTime } from "./recording/callMeeting";
import { registerRecordingIpc } from "./recording/recordingIpc";
import { RecordingStore, type StoredRecording } from "./recording/RecordingStore";
import { Transcriber, type TranscriberDeps } from "./recording/Transcriber";
import { cancelWhisper, prepareWhisper, runWhisper, transcribeSpeech } from "./recording/whisper";
import { CallQuestionStore } from "./recording/CallQuestionStore";
import { askAboutCalls } from "./recording/callQuestions";
import { ActionItemStore } from "./recording/ActionItemStore";
import { ActionItemFinder } from "./recording/actionItems";
import { decodeCallAudio } from "./speakers/decodeCallAudio";
import { callSpeakers, registerSpeakerIpc } from "./speakers/speakerIpc";
import { SpeakerService, type SpeakerServiceDeps } from "./speakers/SpeakerService";
import { SpeakerStore } from "./speakers/SpeakerStore";
import { loadVoicePrinter } from "./speakers/voiceModel";
import { readWav } from "./speakers/wavSamples";
import { cleanUpScreenshots } from "./screenshots/cleanUpScreenshots";
import { captureDisplays, sampleCpuPercent } from "./screenshots/platform";
import { ScreenCapturer } from "./screenshots/ScreenCapturer";
import { handleScreenshotScheme, registerScreenshotScheme } from "./screenshots/screenshotProtocol";
import { enableStartAtLoginOnce } from "./startAtLogin";
import { SecretStore } from "./store/SecretStore";
import { Store } from "./store/Store";
import { type HandoffDependencies, handoffActions, prepareQbdcodeHandoff, sendToQbdcode } from "./todos/handoff";
import { createJiraTicket, jiraActions, readJiraSettings, saveJiraSettings, searchAssignees } from "./todos/jira";
import { draftJiraTicket } from "./todos/jiraDraft";
import { registerTodoIpc } from "./todos/todoIpc";
import { TodoStore } from "./todos/TodoStore";
import { TrayController } from "./TrayController";
import { WindowManager, type Screen } from "./WindowManager";

/** How many past questions about calls the Recordings tab loads; it shows the picked day's, so older days need many. */
const QUESTIONS_SHOWN = 500;

/** The setting that keeps Chrome's last Automation answer, shown while Chrome is closed. */
const CHROME_AUTOMATION_SETTING = "permissions.chromeAutomation";

/** How long quitting waits for a backup in progress before giving up on it. */
const QUIT_WAIT_MS = 30_000;

/** How often old screenshots are cleared out. */
const CLEAN_UP_EVERY_MS = 24 * 60 * 60_000;

/** How long after start the voices of earlier calls are first split. */
const SPEAKERS_FIRST_CATCH_UP_MS = 60_000;

/** How often calls whose voices aren't final are looked for (e.g. once their last chunk is transcribed). */
const SPEAKERS_CATCH_UP_EVERY_MS = 5 * 60_000;

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
  enableStartAtLoginOnce(store, app);
  const activity = new ActivityStore(store.db);
  /** The ignored-apps list as saved in Settings, read fresh each time it's needed. */
  const ignoredApps = () => parseIgnoredApps(store.getSetting(IGNORED_APPS_SETTING));
  const recordings = new RecordingStore(store.db);
  const callQuestions = new CallQuestionStore(store.db);
  const sonnet = new BedrockHaiku(undefined, BEDROCK_SONNET_MODEL);
  const actionItems = new ActionItemStore(store.db);
  const speakerStore = new SpeakerStore(store.db);
  const actionItemFinder = new ActionItemFinder({
    recordings,
    store: actionItems,
    haiku: new BedrockHaiku(),
    speakers: (id) => callSpeakers(speakerStore, id),
    now: () => Date.now(),
  });
  // The speaker service and the transcriber each need the other: lines go to the service as they're
  // stored, and the service waits for a call's last chunk before making its speakers final.
  const speakers: SpeakerService = createSpeakers(speakerStore, recordings, {
    stillTranscribing: (id) => transcriber.waiting(id) > 0,
    isRecording: () => recorder.isRecording(),
  });
  const transcriber = createTranscriber(recordings, (id, chunk, lines) => speakers.chunkTranscribed(id, chunk, lines));
  void speakers.prepareAhead();
  // Finds whisper and the model (downloading it the first time) now, so a problem shows before the first call.
  void transcriber.prepareAhead();
  const recordingsDir = join(app.getPath("userData"), "recordings");
  /**
   * Names a finished call's one audio file after the meeting it overlapped most (Calendar is read only once
   * a call ends, long after it's set up below).
   * @param recording The call.
   */
  const nameAudio = async (recording: StoredRecording) => {
    if (recording.audioPath || recording.end === null) {
      return;
    }
    await mixLeftoverSides(helperPath("meeting-recorder"), recording.folder);
    const meetings = calendar.store
      .listTypedEvents(recording.start, recording.end ?? Date.now())
      .filter((meeting) => meeting.response !== "declined");
    await nameRecordingAudio(recordings, recording, bestMeeting(recording, meetings, Date.now())?.title ?? null, recordingsDir);
    void speakers.catchUp();
  };
  const recorder = new RecordingController({
    store: recordings,
    startRecorder: (folder, events) => startRecorder(helperPath("meeting-recorder"), folder, events),
    transcribe: (id, chunk) => transcriber.add(id, chunk),
    onFinished: (id) => {
      const recording = recordings.getRecording(id);
      if (recording) {
        nameAudio(recording).catch((error: unknown) => console.error("Time Center: couldn't name the call's audio", error));
      }
    },
    recordingsDir,
    onChange: () => tray.refresh(),
    isSoloTime: (now) => isSoloTime(calendar.store.listEvents(now, now + 1), now),
    now: () => Date.now(),
  });
  const tracker = createTracker(activity, ignoredApps, (onCall, callApps) => recorder.callSample(onCall, callApps));
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
  const permissions = createPermissions(store);
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
    isRecording: () => recorder.isRecording(),
  });
  const scheduler = new BackupScheduler(backupService, (result) => {
    backupState.lastError = result.ok ? null : result.error;
    tray.refresh(backupState.lastError);
  });

  registerIpcHandlers({
    store,
    activity,
    calendar: calendar.store,
    permissions,
    backupService,
    scheduler,
    backupState,
    onBackupChanged: () => tray.refresh(backupState.lastError),
    onIgnoredAppsChanged: () => tracker.restart(),
  });
  registerCalendarIpc({
    auth: calendar.auth,
    sync: calendar.sync,
    scheduler: calendar.joins,
    settings: store,
    pickClientFile: async () => {
      const picked = await dialog.showOpenDialog({
        title: "Choose the Google client file (credentials.json)",
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      return picked.canceled || !picked.filePaths[0] ? null : readFile(picked.filePaths[0], "utf8");
    },
    onChange: () => tray.refresh(),
  });
  registerMeetingTypeIpc({
    calendar: calendar.store,
    typer: calendar.typer,
    now: () => Date.now(),
  });
  registerSpeakerIpc({ service: speakers, store: speakerStore });
  registerRecordingIpc({
    store: recordings,
    transcriber,
    speakers: speakerStore,
    listMeetings: (from, to) => calendar.store.listTypedEvents(from, to),
    listWindows: (from, to) => activity.listSegments(from, to),
    showInFinder: (path) => {
      if (path.endsWith(".m4a")) {
        shell.showItemInFolder(path);
      } else {
        void shell.openPath(path);
      }
    },
    countUnread: countUnreadChunks,
    ask: (request) =>
      askAboutCalls(
        {
          recordings,
          questions: callQuestions,
          listMeetings: (from, to) => calendar.store.listTypedEvents(from, to),
          listWindows: (from, to) => activity.listSegments(from, to),
          claude: sonnet,
          speakers: (id) => callSpeakers(speakerStore, id),
          now: () => Date.now(),
        },
        request,
      ),
    listQuestions: () => callQuestions.listQuestions(QUESTIONS_SHOWN),
    dictate: async (wav) => {
      const { whisper, model } = await prepareWhisper(join(app.getPath("userData"), "models"), false);
      return transcribeSpeech(whisper, model, wav, join(app.getPath("temp"), "time-center-dictation"));
    },
    actionItems,
    refreshActionItems: (recordingId) => actionItemFinder.refresh(recordingId),
    now: () => Date.now(),
  });
  const jira = { settings: store, secrets: new SecretStore(store, safeStorage), fetch };
  const handoff: HandoffDependencies = {
    home: homedir(),
    callTranscript: (id) =>
      recordings.getRecording(id) ? { lines: recordings.listLines(id), speakers: callSpeakers(speakerStore, id) } : null,
    openExternal: (url) => shell.openExternal(url),
    run: (file, args, env) =>
      new Promise((resolve, reject) => {
        execFile(file, args, { env: { ...process.env, ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`${stderr || stdout || error.message}`.trim()));
            return;
          }
          resolve(stdout);
        });
      }),
  };
  registerTodoIpc({
    store: new TodoStore(store.db),
    actions: () => [...jiraActions(jira), ...handoffActions(handoff)],
    getJiraSettings: () => readJiraSettings(jira),
    saveJiraSettings: (input) => saveJiraSettings(jira, input),
    draftJiraTicket: (todo, current, instruction) =>
      draftJiraTicket({ jira, claude: sonnet, callTranscript: handoff.callTranscript, now: () => Date.now() }, todo, current, instruction),
    searchJiraUsers: (query) => searchAssignees(jira, query),
    createJiraTicket: (todo, draft) => createJiraTicket(jira, todo, draft),
    prepareQbdcodeHandoff: (todo) => prepareQbdcodeHandoff(handoff, todo),
    sendToQbdcode: (path, text) => sendToQbdcode(handoff, path, text),
    now: () => Date.now(),
  });
  handleScreenshotScheme(activity);
  tray.create();
  recoverRecordings(recordings, transcriber, nameAudio).catch((error: unknown) => {
    console.error("Time Center: couldn't pick up unfinished recordings", error);
  });
  // Stops a recording once its call is over, even if the helper's samples stop coming.
  setInterval(() => recorder.tick(), 5_000);
  // Splits the voices of calls recorded before speakers existed (and finishes ones split live), a while after
  // start so it doesn't compete with starting up, then again every few minutes.
  setTimeout(() => void speakers.catchUp(), SPEAKERS_FIRST_CATCH_UP_MS);
  setInterval(() => void speakers.catchUp(), SPEAKERS_CATCH_UP_EVERY_MS);
  scheduler.start();
  tracker.start();
  capturer.start();
  calendar.sync.start();
  calendar.joins.start();
  // Keeps "Next: …" current as meetings start and end between syncs.
  setInterval(() => tray.refresh(), 60_000);
  /** Deletes screenshots and call audio past the 30-day retention, logging rather than crashing on a failure. */
  const cleanUp = () => {
    cleanUpScreenshots(screenshotsDir, activity, Date.now()).catch((error: unknown) => {
      console.error("Time Center: screenshot clean-up failed", error);
    });
    cleanUpRecordings(recordings, Date.now()).catch((error: unknown) => {
      console.error("Time Center: recording clean-up failed", error);
    });
  };
  cleanUp();
  setInterval(cleanUp, CLEAN_UP_EVERY_MS);

  powerMonitor.on("suspend", () => {
    tracker.pause("asleep");
    recorder.stop();
  });
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
    recorder.stop();
    transcriber.stop();
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

  void permissions.refreshAutomation().then(() => {
    if (permissions.needsAttention()) {
      windows.show("permissions");
    }
  });
}

/**
 * Builds the activity tracker on the Swift front-window helper and macOS's idle timer.
 * @param activity The activity tables.
 * @param ignoredApps Reads the current ignored-apps list; each helper start picks up the latest.
 * @param onCallState Told whether each sample saw a call and which apps are on it, to start, split and stop recording.
 * @returns The tracker, not yet started.
 */
function createTracker(
  activity: ActivityStore,
  ignoredApps: () => string[],
  onCallState: (onCall: boolean, callApps: string[]) => void,
): ActivityTracker {
  return new ActivityTracker({
    recorder: new SegmentRecorder(activity),
    startHelper: (onSample, onExit) =>
      startWindowHelper(helperPath(), SAMPLE_INTERVAL_SECONDS, ignoredApps(), onSample, onExit),
    getIdleMs: () => powerMonitor.getSystemIdleTime() * 1000,
    now: () => Date.now(),
    onCallState,
  });
}

/**
 * Builds the transcriber on whisper.cpp (Homebrew's whisper-cli) and the large-v3-turbo model kept in the
 * app's folder, downloaded the first time it's needed.
 * @param recordings The recordings table, where the lines go.
 * @param onLines Given each chunk's stored lines while its audio is still on disk, to tell voices apart.
 * @returns The transcriber.
 */
function createTranscriber(recordings: RecordingStore, onLines: TranscriberDeps["onLines"]): Transcriber {
  return new Transcriber({
    store: recordings,
    onLines,
    prepare: () => prepareWhisper(join(app.getPath("userData"), "models")),
    run: runWhisper,
    remove: (wav) => rm(wav, { force: true }),
    setAside: (wav) => rename(wav, `${wav}.failed`),
    cancel: cancelWhisper,
    // The Calls card re-reads on its own (every 5 s while a call is busy, else 30 s), so there's nothing to push.
    onChange: () => {},
    log: (message, error) => console.error(message, error),
  });
}

/**
 * Builds the speaker service on TitaNet-small (downloaded into the app's models folder the first time), reading
 * chunks directly and a whole call's mixed audio through macOS's afconvert.
 * @param store The speakers tables.
 * @param recordings The recordings table, for when each call started.
 * @param calls Whether a call is still being transcribed or recorded.
 * @returns The service.
 */
function createSpeakers(
  store: SpeakerStore,
  recordings: RecordingStore,
  calls: Pick<SpeakerServiceDeps, "stillTranscribing" | "isRecording">,
): SpeakerService {
  const speakersTemp = join(app.getPath("temp"), "time-center-speakers");
  // A decoded call left behind by a crash mid-split.
  void rm(speakersTemp, { recursive: true, force: true });
  return new SpeakerService({
    store,
    loadPrinter: () => loadVoicePrinter(join(app.getPath("userData"), "models")),
    readChunk: async (wav) => readWav(await readFile(wav)).samples,
    readCall: (audioPath) => decodeCallAudio(audioPath, speakersTemp),
    recordingStart: (id) => recordings.getRecording(id)?.start ?? null,
    stillTranscribing: calls.stillTranscribing,
    isRecording: calls.isRecording,
    yieldNow: () => new Promise((resolve) => setImmediate(resolve)),
    now: () => Date.now(),
    log: (message, error) => console.error(message, error),
  });
}

/**
 * Builds the calendar side: Google sign-in (the client built into the app, the refresh token kept with
 * the Keychain key), the five-minute sync of the main calendar, the join timer with its notices, and
 * Haiku's sorting of meetings into types after each sync.
 * @param store The database.
 * @param onChange Called when a meeting's state or the sign-in changes, to refresh the tray.
 * @returns The sign-in, the sync, the join timer, the meetings table and the sorter.
 */
function createCalendar(store: Store, onChange: () => void) {
  const secrets = new SecretStore(store, safeStorage);
  const auth = new GoogleAuth({
    secrets,
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
      void typer.typeNew();
    },
    now: () => Date.now(),
  });
  const typer = new MeetingTyper({
    calendar: calendarStore,
    haiku: new BedrockHaiku(),
    ownEmail: () => sync.account(),
    now: () => Date.now(),
  });
  const joiner = new MeetingJoiner({
    openExternal: (url) => shell.openExternal(url),
    openInChrome,
    account: () => sync.account(),
  });
  const joins: JoinScheduler = new JoinScheduler({
    calendar: calendarStore,
    joinMode: () => (auth.isSignedIn() ? readJoinMode(store) : "off"),
    notify: showJoinNotice,
    remind: showJoinReminder,
    join: (event) => joiner.join(event),
    reportFailure: (event, error) => showJoinFailure(`${event.title}: ${error}`),
    onChange,
    now: () => Date.now(),
  });
  return { auth, sync, joins, store: calendarStore, typer };
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
 * Shows the macOS notice that a meeting is starting, for when meetings aren't joined automatically;
 * clicking it joins. The scheduler holds the handle, which keeps the click working.
 * @param event The meeting.
 * @param onJoin Joins the meeting.
 * @returns A handle that takes the notice down.
 */
function showJoinReminder(event: CalendarEvent, onJoin: () => void): Notice {
  const title = event.title.length > 80 ? `${event.title.slice(0, 79)}…` : event.title;
  const starting = event.start > Date.now() ? "is about to start" : "has started";
  const notice = new Notification({ title: `A meeting ${starting} — click to join`, body: title });
  notice.on("click", onJoin);
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
 * Finds a compiled Swift helper.
 * @param name "active-window" (the front-window reader) or "meeting-recorder" (the call recorder).
 * @returns Contents/Resources/bin in the packaged app (electron-builder extraResources); in dev, the
 *   copy built by `npm run native`.
 */
function helperPath(name: "active-window" | "meeting-recorder" = "active-window"): string {
  return app.isPackaged
    ? join(process.resourcesPath, "bin", name)
    : join(app.getAppPath(), "resources/bin", name);
}

/**
 * Wires the permissions logic to Electron's real macOS APIs, keeping Chrome's last answer in settings.
 * @param store The database, for that setting.
 * @returns The permissions service.
 */
function createPermissions(store: Store): Permissions {
  const memory = {
    load: () => store.getSetting(CHROME_AUTOMATION_SETTING),
    save: (state: string) => store.setSetting(CHROME_AUTOMATION_SETTING, state),
  };
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
    readChromeAutomation: () => readAutomationStatus(helperPath()),
  }, memory);
}

/**
 * Picks the screen a second launch asked for with `--open=recordings`, `--open=todos`, `--open=permissions`
 * or `--open=settings`; the dashboard otherwise.
 * @param argv The second instance's command line.
 * @returns The screen to show.
 */
function screenFromArgs(argv: string[]): Screen {
  if (argv.includes("--open=recordings")) {
    return "recordings";
  }
  if (argv.includes("--open=todos")) {
    return "todos";
  }
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
