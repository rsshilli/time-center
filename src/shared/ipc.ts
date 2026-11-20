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

/** The category for your own time. It never counts toward Working. */
export const PERSONAL_CATEGORY = "Personal";

/** How the My time tab reads your time. */
export interface ReportOptions {
  /** Leave Personal time out of every total, and Saturdays and Sundays out of a stretch of days. */
  workOnly: boolean;
}

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
  /** A microphone line read after the speakers' sound was taken out of it (echoGate.ts), so surely you. */
  echoFree?: boolean;
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

/** One of the meetings a call ran through, and when in the call it starts. */
export interface CallMeeting {
  title: string;
  start: number;
}

/** A recorded call, as Today shows it. */
export interface CallRecording {
  id: number;
  start: number;
  /** Null while it is still recording. */
  end: number | null;
  /** The titles of the meetings it ran through, in order ("Frank & Ryan · Dept. OB: Innovation"), if any. */
  meetingTitle: string | null;
  /** Where each of those meetings starts in the call, in order; empty when it matched none. */
  meetings: CallMeeting[];
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
  /** Action items found by Scan for TODOs, newest first; empty if it was never scanned. */
  actionItems: ActionItem[];
  /** When the call was last scanned for TODOs; null if never. */
  actionItemsScannedAt: number | null;
}

/** How long after a call ends it still counts as live, while its last words are being transcribed. */
export const CALL_FINISHING_MS = 10 * 60_000;

/** Something a call suggests someone should do, as Haiku found it. */
export interface ActionItem {
  /** e.g. "You: send Dana the sandbox keys". */
  text: string;
  /** When it was said. */
  saidAt: number;
}

/** How far back "Catch me up" can summarise a call, in minutes. */
export const CATCH_UP_MINUTES = [2, 5, 10] as const;
export type CatchUpMinutes = (typeof CATCH_UP_MINUTES)[number];

/** A summary of the last few minutes of a call, for when you stopped paying attention. */
export interface CatchUp {
  minutes: CatchUpMinutes;
  /** The stretch of the call it covers. */
  from: number;
  to: number;
  /** Haiku's short bullet points, or a note that nothing was said. */
  summary: string;
  /** How many turns were said in that time; 0 when nothing was, and Haiku wasn't asked. */
  turns: number;
}

/** A suggested TODO on the Recordings tab, as it's known when dismissed: its call, when it was said, its words. */
export interface SuggestionRef {
  recordingId: number;
  saidAt: number;
  text: string;
}

/** A call's action items after a scan. */
export interface ActionItemsReport {
  /** Newest first, less the ones you dismissed. */
  items: ActionItem[];
  /** When the scan ran. */
  checkedAt: number;
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

/** One day inside a longer stretch: its working time, split by category, for its bar. */
export interface DayTotals {
  dayStart: number;
  activeMs: number;
  byCategory: Total[];
}

/** Your time over several days (a week so far, the last 7 days, a month): the day report's totals, added up. */
export interface RangeReport {
  /** Local midnight that starts the first day. */
  from: number;
  /** Local midnight after the last day. */
  to: number;
  /** One per day, earliest first. */
  days: DayTotals[];
  activeMs: number;
  idleMs: number;
  untrackedMs: number;
  byCategory: Total[];
  byApp: Total[];
  byProject: Total[];
  byDomain: Total[];
  /** Time in each meeting you attended, by its title, so a weekly meeting adds up across its repeats. */
  byMeeting: Total[];
}

/** The most days one range report covers: a 31-day month and a day to spare. */
export const MAX_RANGE_DAYS = 32;

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

/**
 * Opens Cowork in Claude Desktop, with your tasks listed down the side. Claude Desktop doesn't say which task a
 * hand-off became, so a TODO sent to Cowork links here rather than to its own task.
 */
export const COWORK_URL = "claude://cowork/new";

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
  /** The menu label, e.g. "Draft a Jira ticket with Claude". */
  label: string;
  /** Why it can't run yet (e.g. "Install Claude Desktop first"); null when it's ready. */
  unavailable: string | null;
  /** The popup it opens instead of running straight away, or null when it runs from the menu. */
  dialog: TodoDialog | null;
}

/** The popups an item's menu can open. */
export type TodoDialog = "qbdcode";

/** What the QbDCode popup starts with. */
export interface QbdcodeHandoff {
  /** The instructions written from the item: the item, its call, and what was said around then. */
  text: string;
  /** Your qbdvision worktrees, the main checkout first. */
  worktrees: { path: string; label: string }[];
  /** The worktree picked to start with (one already on a ticket's branch), or null for the first. */
  preferredPath: string | null;
}

/** The most Jira tickets sent to Claude at once. */
export const MAX_HANDOFF_TICKETS = 20;

/** A Jira ticket as handed to Claude: what it is, and its description as plain text. */
export interface TicketBrief {
  key: string;
  summary: string;
  type: string;
  status: string;
  url: string;
  /** The description as plain text; "" when it has none. */
  description: string;
}

/** Where each of your Jira tickets was sent from the TODO tab, newest last, by ticket key. */
export type TicketSends = Record<string, TodoSent[]>;

/** A qbdvision worktree whose branch names a ticket. */
export interface TicketWorktree {
  /** The worktree's folder name, e.g. "qbdvision3". */
  name: string;
  path: string;
  branch: string;
}

/** The qbdvision worktrees on a branch naming each ticket, by ticket key. */
export type TicketWorktrees = Record<string, TicketWorktree[]>;

/** A ticket assigned to you in an open sprint, for the TODO tab. */
export interface SprintTicket {
  key: string;
  summary: string;
  /** Task, Bug, Story… */
  type: string;
  /** The status's own name ("In Testing / Development"). */
  status: string;
  /** Jira's group for the status: to do, in progress or done. */
  statusCategory: "new" | "indeterminate" | "done";
  /** The ticket's page in Jira. */
  url: string;
}

/** A state a ticket can be moved to from where it is. */
export interface TicketMove {
  /** Jira's id for the move (its "transition"). */
  id: string;
  /** The state it leads to, e.g. "In Testing / Development". */
  status: string;
  statusCategory: SprintTicket["statusCategory"];
}

/** Your tickets in the open sprints, or why they couldn't be read. */
export interface SprintTicketsReport {
  /** In the board's order, finished ones last. */
  tickets: SprintTicket[];
  /** The open sprints they're in, e.g. ["PØD-2026-22"]. */
  sprints: string[];
  /** Why the list couldn't be read (Jira not set up, or unreachable); null when it was. */
  problem: string | null;
}



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
  logProblem: "app:log-problem",
  getDay: "activity:get-day",
  getRange: "activity:get-range",
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
  scanActionItems: "recordings:scan-action-items",
  catchUpOnCall: "recordings:catch-up",
  dismissSuggestion: "recordings:dismiss-suggestion",
  restoreSuggestion: "recordings:restore-suggestion",
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
  getSprintTickets: "jira:sprint-tickets",
  listTicketMoves: "jira:ticket-moves",
  moveTicket: "jira:move-ticket",
  prepareQbdcodeHandoff: "qbdcode:prepare",
  sendToQbdcode: "qbdcode:send",
  getTicketSends: "tickets:sends",
  getTicketWorktrees: "tickets:worktrees",
  sendTicketsToCowork: "tickets:cowork",
  prepareTicketsQbdcode: "tickets:qbdcode-prepare",
  sendTicketsToQbdcode: "tickets:qbdcode-send",
  nameSpeaker: "speakers:name",
  setLineNotYou: "lines:set-not-you",
  getVoices: "voices:get",
  renameVoice: "voices:rename",
  forgetVoice: "voices:forget",
} as const;

/** The API the preload script exposes to the renderer as `window.timeCenter`. */
export interface TimeCenterApi {
  /**
   * Writes something that went wrong on the page to the app's log (~/Library/Logs/Time Center/app.log).
   * @param source The part of the page, e.g. "todos" or "error".
   * @param message What happened.
   */
  logProblem(source: string, message: string): Promise<void>;
  /** The timeline, screenshots and totals for the local day that contains this moment. */
  getDay(at: number, options: ReportOptions): Promise<DayReport>;
  /** The totals for the local days from one midnight up to another, at most MAX_RANGE_DAYS of them. */
  getRange(from: number, to: number, options: ReportOptions): Promise<RangeReport>;
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
  /** Scans a call for potential action items with Sonnet, now, keeping the ones found before. */
  scanActionItems(recordingId: number): Promise<ActionItemsReport>;
  /** Summarises the last 2, 5 or 10 minutes of a call with Haiku, for when you stopped paying attention. */
  catchUpOnCall(recordingId: number, minutes: CatchUpMinutes): Promise<CatchUp>;
  /** Dismisses a suggested TODO on the Recordings tab, so it isn't shown again (nor found again by Haiku). */
  dismissSuggestion(suggestion: SuggestionRef): Promise<void>;
  /** Undoes a dismissal. */
  restoreSuggestion(suggestion: SuggestionRef): Promise<void>;
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
  /** The Jira tickets assigned to you in the open sprints. */
  getSprintTickets(): Promise<SprintTicketsReport>;
  /** The states a ticket can be moved to from where it is. */
  listTicketMoves(key: string): Promise<TicketMove[]>;
  /** Moves a ticket to another state and returns your sprint list as it is then. */
  moveTicket(key: string, moveId: string): Promise<SprintTicketsReport>;
  /** The instructions and worktrees the QbDCode popup starts with. */
  prepareQbdcodeHandoff(todoId: number): Promise<QbdcodeHandoff>;
  /** Starts a QbDCode chat in a worktree on the instructions, and returns the list with it recorded on the item. */
  sendToQbdcode(todoId: number, worktreePath: string, text: string): Promise<Todo[]>;
  /** Where your Jira tickets were sent from the TODO tab. */
  getTicketSends(): Promise<TicketSends>;
  /** Which of your qbdvision worktrees are on a branch naming each ticket, read from the branch names now. */
  getTicketWorktrees(): Promise<TicketWorktrees>;
  /** Opens a Cowork task in Claude Desktop on Jira tickets, and returns where tickets were sent, this one included. */
  sendTicketsToCowork(keys: string[]): Promise<TicketSends>;
  /** The instructions and worktrees the QbDCode popup starts with, for Jira tickets. */
  prepareTicketsQbdcode(keys: string[]): Promise<QbdcodeHandoff>;
  /** Starts one QbDCode chat on Jira tickets, and returns where tickets were sent, this one included. */
  sendTicketsToQbdcode(keys: string[], worktreePath: string, text: string): Promise<TicketSends>;
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
