import { ipcMain } from "electron";
import { IPC, type MeetingType } from "../../shared/ipc";
import { assertEventId } from "./calendarIpc";
import { isMeetingType, type CalendarStore } from "./CalendarStore";
import type { MeetingTyper } from "./MeetingTyper";

/** What the meeting-type IPC handlers act on. */
export interface MeetingTypeIpcDeps {
  calendar: Pick<CalendarStore, "getEvent" | "setMeetingType">;
  typer: Pick<MeetingTyper, "typeAgain" | "status">;
  now(): number;
}

/**
 * Answers the dashboard's type picker and Settings' "Sort meetings now". Every handler checks its input,
 * since the renderer is treated as untrusted.
 * @param deps The tables and Haiku.
 */
export function registerMeetingTypeIpc(deps: MeetingTypeIpcDeps): void {
  ipcMain.handle(IPC.setMeetingType, (_event, eventId: unknown, type: unknown) =>
    setMeetingTypeByYou(deps, assertEventId(eventId), assertMeetingType(type)),
  );
  ipcMain.handle(IPC.getMeetingTypeStatus, () => deps.typer.status());
  ipcMain.handle(IPC.sortMeetingsNow, async () => {
    await deps.typer.typeAgain();
    return deps.typer.status();
  });
}

/**
 * Records your choice of type for a meeting's whole repeating series.
 * @param deps The tables and the clock.
 * @param eventId Any occurrence of the meeting.
 * @param type The type.
 */
export function setMeetingTypeByYou(deps: Pick<MeetingTypeIpcDeps, "calendar" | "now">, eventId: string, type: MeetingType): void {
  const event = deps.calendar.getEvent(eventId);
  if (!event) {
    throw new Error("That meeting is no longer on the calendar.");
  }
  deps.calendar.setMeetingType(event.seriesId, type, "you", deps.now());
}

/**
 * Checks that a value from the renderer is a meeting type.
 * @param type The value.
 * @returns It, typed.
 */
export function assertMeetingType(type: unknown): MeetingType {
  if (!isMeetingType(type)) {
    throw new Error(`Not a meeting type: ${String(type).slice(0, 40)}`);
  }
  return type;
}
