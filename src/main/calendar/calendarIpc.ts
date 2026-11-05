import { ipcMain } from "electron";
import { IPC, type CalendarStatus } from "../../shared/ipc";
import type { CalendarSync } from "./CalendarSync";
import type { GoogleAuth } from "./GoogleAuth";
import type { JoinScheduler } from "./JoinScheduler";

/** The setting that turns automatic joining off ("false"); anything else, including unset, means on. */
export const AUTO_JOIN_SETTING = "autoJoin";

/** What the calendar's IPC handlers act on. */
export interface CalendarIpcDeps {
  auth: Pick<GoogleAuth, "hasClient" | "isSignedIn" | "setClient" | "signIn" | "signOut">;
  sync: Pick<CalendarSync, "syncNow" | "status" | "account" | "reset">;
  scheduler: Pick<JoinScheduler, "meetings" | "skip" | "joinNow" | "tick">;
  settings: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void };
  /** The folder Chrome loads the companion extension from. */
  extensionPath: string;
  /** Asks for a credentials.json and returns its text, or null when cancelled. */
  pickClientFile(): Promise<string | null>;
  /** Shows a folder in Finder. */
  showFolder(path: string): Promise<void>;
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
  ipcMain.handle(IPC.setAutoJoin, (_event, on: unknown) => {
    if (typeof on !== "boolean") {
      throw new Error("Auto-join must be on or off.");
    }
    deps.settings.setSetting(AUTO_JOIN_SETTING, on ? null : "false");
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
  ipcMain.handle(IPC.showExtensionFolder, () => deps.showFolder(deps.extensionPath));
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
    autoJoin: isAutoJoinOn(deps.settings),
    ...deps.sync.status(),
    extensionPath: deps.extensionPath,
    meetings: signedIn ? deps.scheduler.meetings() : [],
  };
}

/**
 * Reads the auto-join setting, which starts on.
 * @param settings The settings table.
 * @returns True unless it was turned off.
 */
export function isAutoJoinOn(settings: { getSetting(key: string): string | null }): boolean {
  return settings.getSetting(AUTO_JOIN_SETTING) !== "false";
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
