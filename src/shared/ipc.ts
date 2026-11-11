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
  /** Whether you were on a call (some app using the microphone). Unset reads as no. */
  onCall?: boolean;
  /** Set when the stretch is Away time you filled in yourself on the timeline. */
  manual?: { id: number; eventId: string | null };
}

/** A stretch you marked on the timeline, such as a call taken on your phone. Times are milliseconds since 1970. */
export interface ManualEntry {
  id: number;
  start: number;
  end: number;
  /** Where the time goes when it isn't a calendar meeting: "Meetings · Other", "Driving", or your own words. */
  category: string;
  /** The calendar meeting it was, whose type then decides the category; null for none. */
  eventId: string | null;
}

/** The longest category you can type for a marked stretch. */
export const MAX_ENTRY_CATEGORY_LENGTH = 60;

/** A new marked stretch: everything but the id. */
export type NewManualEntry = Omit<ManualEntry, "id">;

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

/** The kinds of meeting the Categories card splits meeting time into. */
export type MeetingType = "one-on-one" | "dsu" | "management" | "architecture" | "customer" | "other";

/** Each meeting type's name on screen, in the order the type picker lists them. */
export const MEETING_TYPE_LABELS: Readonly<Record<MeetingType, string>> = {
  "one-on-one": "One on ones",
  dsu: "DSU",
  management: "Management/Exec",
  architecture: "Architecture/product review",
  customer: "Customer",
  other: "Other",
};

/** The category meeting time goes in while its meeting's type isn't known yet. */
export const MEETINGS_CATEGORY = "Meetings";

/**
 * Names the category for one type of meeting.
 * @param type The meeting's type, or null while it isn't known.
 * @returns e.g. "Meetings · One on ones", or plain "Meetings".
 */
export function meetingCategory(type: MeetingType | null): string {
  return type ? `${MEETINGS_CATEGORY} · ${MEETING_TYPE_LABELS[type]}` : MEETINGS_CATEGORY;
}

/** One of the day's calendar meetings on the dashboard, with its type. Times are milliseconds since 1970. */
export interface DayMeeting {
  eventId: string;
  title: string;
  start: number;
  end: number;
  type: MeetingType | null;
  /** Who set the type: Claude Haiku's guess, or you. Null while it isn't known. */
  typeSource: "haiku" | "you" | null;
  /**
   * Whether you were in a call during it, met in person, or marked a stretch during it as this meeting;
   * only then does its time count as the meeting's.
   */
  attended: boolean;
  /** Active time counted toward it. */
  ms: number;
}

/** What Settings shows about sorting meetings into types with Claude Haiku on Amazon Bedrock. */
export interface MeetingTypeStatus {
  /** Where the AWS keys came from, once a sort has looked; null before. */
  via: string | null;
  /** When Haiku last sorted meetings. */
  lastRunAt: number | null;
  lastError: string | null;
}

/** One spoken stretch of a call's transcript. */
export interface TranscriptLine {
  /** "me" is your microphone; "them" is everything the Mac played. */
  side: "me" | "them";
  start: number;
  end: number;
  text: string;
  /** Which of the call's speakers said it ("them" lines only); null when unknown. */
  speakerId: number | null;
  /** The stored line's id (absent on lines not read from the database). */
  id?: number;
  /** A microphone line you said wasn't you: hidden, and never part of your voice. */
  notYou?: boolean;
}

/** One voice on the other side of a call. */
export interface CallSpeaker {
  id: number;
  /** "Speaker 1", "Speaker 2"… in the order they first spoke. */
  number: number;
  /** Who it is, when you named them or their voice matched someone you named; null when unknown. */
  name: string | null;
  /** False when the name is only a guess for you to confirm (shown as "Dana?"). */
  sure: boolean;
}

/** Someone you've named, as Settings lists them. */
export interface NamedVoice {
  id: number;
  name: string;
  /** How many calls you named them in or they were recognized in. */
  calls: number;
}

/** A recorded call, as Today shows it. */
export interface CallRecording {
  id: number;
  start: number;
  /** Null while it is still recording. */
  end: number | null;
  /** The calendar meeting it overlapped most, if any. */
  meetingTitle: string | null;
  /** False when macOS refused the microphone, so only the other side was recorded. */
  mic: boolean;
  /** Why recording stopped early, if it did. */
  error: string | null;
  /** Whether the audio files are still on the Mac (they're deleted after 30 days). */
  audioKept: boolean;
  /** Pieces of audio still waiting for whisper. */
  waitingChunks: number;
  /** Pieces whisper couldn't read, set aside (still in the audio files). */
  unreadChunks: number;
  lines: TranscriptLine[];
  /** The voices heard on the other side, by number. */
  speakers: CallSpeaker[];
  /** Names to offer when you name a speaker: the meeting's invitees first, then everyone named before. */
  nameChoices: string[];
  /** Action items Haiku found while you watched the call, newest first; empty if it never looked. */
  actionItems: ActionItem[];
  /** Whether Haiku has looked at this call and words came in since, so it still owes a final look. */
  actionItemsBehind: boolean;
}

/**
 * How long after a call ends it still counts as live: its last words are being transcribed and Haiku may take
 * a final look. After that, action items are never looked for again.
 */
export const CALL_FINISHING_MS = 10 * 60_000;

/** Something a call suggests someone should do, as Haiku found it. */
export interface ActionItem {
  /** e.g. "You: send Dana the sandbox keys". */
  text: string;
  /** When it was said. */
  saidAt: number;
}

/** A live call's action items, after Haiku looked again (or chose not to: nothing new was said). */
export interface ActionItemsReport {
  /** Newest first. */
  items: ActionItem[];
  /** When Haiku last read the call; null if it never has. */
  checkedAt: number | null;
  /** Why the last look failed, or null. */
  problem: string | null;
}

/** The day's recorded calls, and anything stopping transcription. */
export interface RecordingsReport {
  recordings: CallRecording[];
  /** e.g. "whisper.cpp isn't installed…", or null when transcription can run. */
  transcriberProblem: string | null;
}

/** Which calls a question is about: one call, the picked day's calls, or every call that mentions its words. */
export type CallQuestionScope = "call" | "day" | "all";

/** The scopes, for checking what the renderer sends. */
export const CALL_QUESTION_SCOPES: readonly CallQuestionScope[] = ["call", "day", "all"];

/** A question to ask about your calls. */
export interface CallQuestionRequest {
  question: string;
  scope: CallQuestionScope;
  /** A moment in the picked day, for "day" (and to find "call"'s day). */
  at: number;
  /** The call, for "call"; null otherwise. */
  recordingId: number | null;
}

/** A call whose transcript was sent with a question. */
export interface CallQuestionSource {
  recordingId: number;
  start: number;
  /** The meeting it overlapped, or null. */
  title: string | null;
}

/** A question you asked, with Sonnet's answer, as saved. */
export interface CallQuestion {
  id: number;
  askedAt: number;
  question: string;
  scope: CallQuestionScope;
  sources: CallQuestionSource[];
  /** How the calls were picked, when that matters, e.g. "No calls mention those words, so…". */
  note: string | null;
  /** Null when asking failed. */
  answer: string | null;
  error: string | null;
  /** The TODOs Sonnet found in the calls while answering, each with the call and moment it came from. */
  todos: CallQuestionTodo[];
}

/** A TODO Sonnet found while answering a question, ready to add to your list. */
export interface CallQuestionTodo {
  text: string;
  recordingId: number;
  /** When it was said, to the minute, or the call's start when Sonnet didn't say. */
  saidAt: number;
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
  /** The day's calendar meetings you didn't decline, earliest first. */
  meetings: DayMeeting[];
  /** Every calendar block you didn't decline, including ones with nobody else invited ("Drive to …"). */
  allMeetings: DayMeeting[];
}

/** The meeting services the app can join. */
export type MeetingProvider = "meet" | "zoom" | "teams";

/**
 * What happens when a meeting is about to start. join: it's opened automatically. notify: a notice says
 * it's starting, and clicking it joins. off: nothing.
 */
export type JoinMode = "join" | "notify" | "off";

/** Every join mode, to check what the renderer sends. */
export const JOIN_MODES: readonly JoinMode[] = ["join", "notify", "off"];

/**
 * Where one meeting stands. will-join: it'll be joined at its join time. joining: the 30-second notice is
 * up. will-notify: a click-to-join notice will show at its join time. notified: that notice was shown.
 * joined / skipped / failed: decided. missed: its join time passed while the Mac slept or the app was
 * closed. no-link, declined: never joined. auto-join-off: the setting is off.
 */
export type MeetingState =
  | "will-join"
  | "joining"
  | "will-notify"
  | "notified"
  | "joined"
  | "skipped"
  | "failed"
  | "missed"
  | "no-link"
  | "declined"
  | "auto-join-off";

/** One meeting in the list on the Settings screen and in the tray. Times are milliseconds since 1970. */
export interface MeetingInfo {
  eventId: string;
  title: string;
  start: number;
  end: number;
  provider: MeetingProvider | null;
  state: MeetingState;
  /** When it will be (or was) joined; null when it won't be. */
  joinAt: number | null;
}

/** What the Settings screen shows about Google Calendar and auto-join. */
export interface CalendarStatus {
  /** Whether a Google OAuth client (credentials.json) has been chosen. */
  hasClient: boolean;
  signedIn: boolean;
  /** The calendar's Google account, once known. */
  account: string | null;
  joinMode: JoinMode;
  lastSyncAt: number | null;
  lastError: string | null;
  /** Today's remaining meetings and the next day's, soonest first. */
  meetings: MeetingInfo[];
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

/** The call a TODO came from, when it was added from the call's action items. */
export interface TodoSource {
  /** Null once the call itself was deleted; the title and time stay. */
  recordingId: number | null;
  title: string;
  /** When it was said in the call. */
  saidAt: number;
}

/** A place a TODO was sent, such as the Jira ticket made from it. */
export interface TodoSent {
  /** The action that sent it, e.g. "jira". */
  action: string;
  /** What to show, e.g. "QI-1234". */
  label: string;
  url: string | null;
  at: number;
}

/** The parts of the TODO list, in the order they're shown. */
export const TODO_SECTIONS = ["work", "personal"] as const;

/** Which part of the TODO list an item sits in. */
export type TodoSection = (typeof TODO_SECTIONS)[number];

/** The items still to do in each section, in order. */
export type TodoLayout = Record<TodoSection, number[]>;

/** One item on the TODO list. */
export interface Todo {
  id: number;
  /** The item as Markdown. */
  markdown: string;
  section: TodoSection;
  createdAt: number;
  /** When it was ticked; null while it's still to do. */
  doneAt: number | null;
  source: TodoSource | null;
  sent: TodoSent[];
}

/** A new item: its text, its section, and the call it came from if any. */
export interface NewTodo {
  markdown: string;
  section: TodoSection;
  source: TodoSource | null;
}

/** Something that can be done with an item from its menu, such as making a Jira ticket. */
export interface TodoActionInfo {
  id: string;
  /** The menu label, e.g. "Make a Jira ticket". */
  label: string;
  /** Why it can't run yet (e.g. "Set up Jira in Settings first"); null when it's ready. */
  unavailable: string | null;
  /** "jira" when it opens the Jira popup instead of running straight away; null otherwise. */
  dialog: "jira" | null;
}

/** Someone a Jira ticket can be assigned to. */
export interface JiraUser {
  accountId: string;
  displayName: string;
}

/** A Jira ticket as proposed in the popup, before it's made. */
export interface JiraDraft {
  /** One of the ticket types saved in Settings. */
  issueType: string;
  summary: string;
  /** Markdown; it's turned into Jira's format when the ticket is made. */
  description: string;
  /** Null leaves the ticket unassigned. */
  assignee: JiraUser | null;
  /** One of the project's Engineering Team choices, or null for none. */
  team: string | null;
}

/** A proposed ticket, with the choices the popup offers. */
export interface JiraDraftResult {
  draft: JiraDraft;
  issueTypes: string[];
  /** The Engineering Team choices; empty when the project has no such field. */
  teams: string[];
  /** Something to tell you about the proposal, e.g. that the person named couldn't be found in Jira. */
  note: string | null;
}

/** The longest Jira summary Jira accepts. */
export const MAX_JIRA_SUMMARY_CHARS = 255;

/** The longest Jira description accepted from the popup, in characters of Markdown. */
export const MAX_JIRA_DESCRIPTION_CHARS = 30_000;

/** The Jira settings, as Settings shows them. The token itself never comes back to the window. */
export interface JiraSettings {
  /** e.g. "https://cherrycircle.atlassian.net". */
  site: string;
  email: string;
  projectKey: string;
  /** The ticket types the menu offers, e.g. ["Task", "Story (FRS)", "Epic (URS)", "Bug"]. */
  issueTypes: string[];
  hasToken: boolean;
}

/** Jira settings to save; token null keeps the saved one. */
export interface JiraSettingsInput {
  site: string;
  email: string;
  projectKey: string;
  issueTypes: string[];
  token: string | null;
}

/** The longest TODO accepted, in characters of Markdown. */
export const MAX_TODO_CHARS = 20_000;

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
  getCalendarStatus: "calendar:status",
  chooseGoogleClient: "calendar:choose-client",
  signInToGoogle: "calendar:sign-in",
  signOutOfGoogle: "calendar:sign-out",
  setJoinMode: "calendar:set-join-mode",
  skipMeeting: "calendar:skip",
  joinMeetingNow: "calendar:join-now",
  setMeetingType: "meetings:set-type",
  getMeetingTypeStatus: "meetings:type-status",
  sortMeetingsNow: "meetings:sort-now",
  addManualEntry: "activity:add-manual-entry",
  deleteManualEntry: "activity:delete-manual-entry",
  copyScreenshot: "screenshots:copy",
  getRecordings: "recordings:get",
  showRecordingAudio: "recordings:show-audio",
  askAboutCalls: "recordings:ask",
  getCallQuestions: "recordings:questions",
  transcribeDictation: "recordings:dictate",
  refreshActionItems: "recordings:action-items",
  getTodos: "todos:get",
  addTodo: "todos:add",
  updateTodo: "todos:update",
  setTodoDone: "todos:set-done",
  arrangeTodos: "todos:arrange",
  deleteTodo: "todos:delete",
  clearDoneTodos: "todos:clear-done",
  getTodoActions: "todos:actions",
  runTodoAction: "todos:run-action",
  getJiraSettings: "jira:get-settings",
  saveJiraSettings: "jira:save-settings",
  draftJiraTicket: "jira:draft",
  searchJiraUsers: "jira:users",
  createJiraTicket: "jira:create",
  nameSpeaker: "speakers:name",
  setLineNotYou: "lines:set-not-you",
  getVoices: "voices:get",
  renameVoice: "voices:rename",
  forgetVoice: "voices:forget",
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
  /** Google sign-in, the auto-join setting and the coming meetings. */
  getCalendarStatus(): Promise<CalendarStatus>;
  /** Asks for a Google OAuth client file (credentials.json) and keeps it encrypted. */
  chooseGoogleClient(): Promise<CalendarStatus>;
  /** Opens Google's sign-in page in the browser and resolves once you've allowed calendar access. */
  signInToGoogle(): Promise<CalendarStatus>;
  /** Forgets the Google sign-in and stops joining meetings. */
  signOutOfGoogle(): Promise<CalendarStatus>;
  /** Chooses whether meetings are joined automatically, announced with a click-to-join notice, or left alone. */
  setJoinMode(mode: JoinMode): Promise<CalendarStatus>;
  /** Won't join this occurrence of the meeting. */
  skipMeeting(eventId: string): Promise<CalendarStatus>;
  /** Joins the meeting straight away. */
  joinMeetingNow(eventId: string): Promise<CalendarStatus>;
  /** Sets a meeting's type yourself; every occurrence of a repeating meeting takes it, and Haiku won't change it. */
  setMeetingType(eventId: string, type: MeetingType): Promise<void>;
  /** Where the AWS keys came from and how Haiku's last sort went. */
  getMeetingTypeStatus(): Promise<MeetingTypeStatus>;
  /** Sorts any meetings still without a type now, and returns how it went. */
  sortMeetingsNow(): Promise<MeetingTypeStatus>;
  /** Marks a stretch yourself; it fills the Away time inside it. */
  addManualEntry(entry: NewManualEntry): Promise<void>;
  /** Removes a stretch you marked. */
  deleteManualEntry(id: number): Promise<void>;
  /** Puts a screenshot on the clipboard at its full, original resolution. */
  copyScreenshot(id: number): Promise<void>;
  /** The calls recorded on the local day that contains this moment, with their transcripts. */
  getRecordings(at: number): Promise<RecordingsReport>;
  /** Shows a call's audio files in Finder. */
  showRecordingAudio(id: number): Promise<void>;
  /** Asks Sonnet a question about your calls; the question and its answer (or error) are saved. */
  askAboutCalls(request: CallQuestionRequest): Promise<CallQuestion>;
  /** The questions you asked before, newest first. */
  getCallQuestions(): Promise<CallQuestion[]>;
  /** Turns dictated speech (a 16 kHz mono 16-bit WAV) into text with whisper, on the Mac. */
  transcribeDictation(wav: ArrayBuffer): Promise<string>;
  /**
   * A call's potential action items. Asked only while the Recordings tab shows a live call, so Haiku only
   * reads a call you're watching; it looks again when there are new words and a minute has passed.
   */
  refreshActionItems(recordingId: number): Promise<ActionItemsReport>;
  /** The TODO list: items to do in your order, then done items, most recently done first. */
  getTodos(): Promise<Todo[]>;
  /** Adds an item at the top of the list. */
  addTodo(todo: NewTodo): Promise<Todo[]>;
  /** Replaces an item's text. */
  updateTodo(id: number, markdown: string): Promise<Todo[]>;
  /** Ticks or unticks an item. */
  setTodoDone(id: number, done: boolean): Promise<Todo[]>;
  /** Puts the items still to do in these sections, in this order. */
  arrangeTodos(layout: TodoLayout): Promise<Todo[]>;
  deleteTodo(id: number): Promise<Todo[]>;
  /** Deletes every done item. */
  clearDoneTodos(): Promise<Todo[]>;
  /** What an item's menu offers, and whether each is ready. */
  getTodoActions(): Promise<TodoActionInfo[]>;
  /** Runs a menu action on an item (e.g. makes a Jira ticket) and returns the list with it recorded. */
  runTodoAction(id: number, actionId: string): Promise<Todo[]>;
  getJiraSettings(): Promise<JiraSettings>;
  /** Saves the Jira settings after checking them against Jira; throws with Jira's answer when they don't work. */
  saveJiraSettings(input: JiraSettingsInput): Promise<JiraSettings>;
  /**
   * Has Sonnet propose a Jira ticket for an item, or change the proposal as asked.
   * @param current The proposal as it stands in the popup, or null for a first draft.
   * @param instruction What to change, e.g. "make it a bug for Platform"; null for a first draft.
   */
  draftJiraTicket(todoId: number, current: JiraDraft | null, instruction: string | null): Promise<JiraDraftResult>;
  /** The people a ticket can be assigned to whose name or email matches. */
  searchJiraUsers(query: string): Promise<JiraUser[]>;
  /** Makes the ticket and returns the list with it recorded on the item. */
  createJiraTicket(todoId: number, draft: JiraDraft): Promise<Todo[]>;
  /** Says who a call speaker is (their voice is then recognized in other calls), or null for "Speaker N". */
  nameSpeaker(speakerId: number, name: string | null): Promise<void>;
  /**
   * Says a line from your microphone wasn't you (hidden, and taken out of your voice), or was after all.
   * Resolves false when the call's audio is gone, so your voice can't be learned again without it.
   */
  setLineNotYou(lineId: number, notYou: boolean): Promise<boolean>;
  /** Everyone you've named, by name. */
  getVoices(): Promise<NamedVoice[]>;
  renameVoice(voiceId: number, name: string): Promise<NamedVoice[]>;
  /** Forgets someone and their voiceprint; their calls go back to "Speaker N". */
  forgetVoice(voiceId: number): Promise<NamedVoice[]>;
}
