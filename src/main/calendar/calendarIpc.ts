import { ipcMain } from "electron";
import { IPC, JOIN_MODES, type CalendarStatus, type JoinMode } from "../../shared/ipc";
import type { CalendarSync } from "./CalendarSync";
import type { GoogleAuth } from "./GoogleAuth";
import type { JoinScheduler } from "./JoinScheduler";

/**
 * The setting for what happens as a meeting starts: "false" for nothing, "notify" for a click-to-join
 * notice, and anything else, including unset, to join automatically. ("false" is what the older on/off
 * switch stored, so it keeps meaning off.)
 */
export const AUTO_JOIN_SETTING = "autoJoin";

/** What each join mode stores in the setting. */
const STORED_MODE: Record<JoinMode, string | null> = { join: null, notify: "notify", off: "false" };

/** What the calendar's IPC handlers act on. */
export interface CalendarIpcDeps {
  auth: Pick<GoogleAuth, "hasClient" | "isSignedIn" | "setClient" | "signIn" | "signOut">;
  sync: Pick<CalendarSync, "syncNow" | "status" | "account" | "reset">;
  scheduler: Pick<JoinScheduler, "meetings" | "skip" | "joinNow" | "tick">;
  settings: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void };
  /** Asks for a credentials.json and returns its text, or null when cancelled. */
  pickClientFile(): Promise<string | null>;
  /** Called when meetings or the sign-in change, so the tray can refresh. */
  onChange(): void;
}

/**
 * Answers the Settings screen's calendar requests. Every handler checks its input, since the renderer is
 * treated as untrusted, and answers with the fresh status.
 * @param deps The sign-in, sync and scheduler.
 */
export function registerCalendarIpc(deps: CalendarIpcDeps): void {
  ipcMain.handle(IPC.getCalendarStatus, () => buildCalendarStatus(deps));
  ipcMain.handle(IPC.chooseGoogleClient, async () => {
    const text = await deps.pickClientFile();
    if (text !== null) {
      deps.auth.setClient(text);
    }
    return buildCalendarStatus(deps);
  });
  ipcMain.handle(IPC.signInToGoogle, async () => {
    await deps.auth.signIn();
    deps.sync.reset();
    await deps.sync.syncNow();
    deps.onChange();
    return buildCalendarStatus(deps);
  });
  ipcMain.handle(IPC.signOutOfGoogle, async () => {
    await deps.auth.signOut();
    deps.sync.reset();
    deps.onChange();
    return buildCalendarStatus(deps);
  });
  ipcMain.handle(IPC.setJoinMode, (_event, mode: unknown) => {
    if (!JOIN_MODES.includes(mode as JoinMode)) {
      throw new Error("Choose join, notify or off.");
    }
    deps.settings.setSetting(AUTO_JOIN_SETTING, STORED_MODE[mode as JoinMode]);
    deps.scheduler.tick();
    deps.onChange();
    return buildCalendarStatus(deps);
  });
  ipcMain.handle(IPC.skipMeeting, (_event, eventId: unknown) => {
    deps.scheduler.skip(assertEventId(eventId));
    return buildCalendarStatus(deps);
  });
  ipcMain.handle(IPC.joinMeetingNow, async (_event, eventId: unknown) => {
    await deps.scheduler.joinNow(assertEventId(eventId));
    return buildCalendarStatus(deps);
  });
}

/**
 * Collects what Settings shows about the calendar.
 * @param deps The services.
 * @returns The status.
 */
export function buildCalendarStatus(deps: CalendarIpcDeps): CalendarStatus {
  const signedIn = deps.auth.isSignedIn();
  return {
    hasClient: deps.auth.hasClient(),
    signedIn,
    account: signedIn ? deps.sync.account() : null,
    joinMode: readJoinMode(deps.settings),
    ...deps.sync.status(),
    meetings: signedIn ? deps.scheduler.meetings() : [],
  };
}

/**
 * Reads what happens as a meeting starts; it starts as joining automatically.
 * @param settings The settings table.
 * @returns The join mode.
 */
export function readJoinMode(settings: { getSetting(key: string): string | null }): JoinMode {
  const stored = settings.getSetting(AUTO_JOIN_SETTING);
  if (stored === "false") {
    return "off";
  }
  return stored === "notify" ? "notify" : "join";
}

/**
 * Checks that a value from the renderer looks like a Google event id.
 * @param eventId The value.
 * @returns It, typed.
 */
export function assertEventId(eventId: unknown): string {
  if (typeof eventId !== "string" || !/^[\w-]{1,1024}$/.test(eventId)) {
    throw new Error(`Not a meeting id: ${String(eventId).slice(0, 40)}`);
  }
  return eventId;
}
