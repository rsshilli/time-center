import { readFileSync } from "node:fs";
import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions, type NativeImage } from "electron";
import trayIconPath from "../../resources/tray.png?asset";
import trayIcon2xPath from "../../resources/tray@2x.png?asset";
import recordingIconPath from "../../resources/tray-recording.png?asset";
import recordingIcon2xPath from "../../resources/tray-recording@2x.png?asset";
import type { MeetingInfo } from "../shared/ipc";
import type { BackupService } from "./backup/BackupService";
import type { WindowManager } from "./WindowManager";

/** What the tray needs from the rest of the app. */
export interface TrayDependencies {
  backupService: BackupService;
  windows: WindowManager;
  onBackupNow: () => Promise<void>;
  /** Whether Google Calendar is signed in, and the coming meetings. */
  meetings: () => { signedIn: boolean; list: MeetingInfo[] };
  onSkipMeeting: (eventId: string) => void;
  onJoinMeeting: (eventId: string) => void;
  /** Whether a call is being recorded, which puts a red dot on the icon. */
  isRecording: () => boolean;
}

/** One meeting line in the menu, before it becomes an Electron menu item. */
export interface MeetingMenuItem {
  label: string;
  action: { kind: "skip" | "join"; eventId: string } | { kind: "settings" } | null;
}

/**
 * The menu-bar icon and its menu: the next meeting (skip its join, or join now), open the app's screens,
 * see when the last backup ran, back up now, and quit. The menu is rebuilt whenever the backup state or
 * a meeting changes.
 */
export class TrayController {
  private tray: Tray | null = null;
  private lastBackupError: string | null = null;
  /** Whether the icon now showing is the red-dot one. */
  private showingRecording = false;

  /** @param deps The services the menu acts on. */
  constructor(private readonly deps: TrayDependencies) {}

  /** Puts the icon in the menu bar. */
  create(): void {
    this.tray = new Tray(loadTrayIcon(trayIconPath, trayIcon2xPath));
    this.tray.setToolTip("Time Center");
    this.refresh(null);
  }

  /**
   * Rebuilds the menu with the current meeting and backup lines.
   * @param lastError The most recent backup error, or null when the last attempt worked; left out when only
   *   the meetings changed.
   */
  refresh(lastError: string | null = this.lastBackupError): void {
    this.lastBackupError = lastError;
    if (!this.tray) {
      return;
    }
    this.updateIcon();
    const { signedIn, list } = this.deps.meetings();
    const meetingItems = meetingMenuItems(signedIn, list, Date.now()).map(
      (item): MenuItemConstructorOptions => ({
        label: item.label,
        enabled: item.action !== null,
        click: () => this.runMeetingAction(item.action),
      }),
    );
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        ...(this.showingRecording ? [{ label: "● Recording this call", enabled: false }] : []),
        ...meetingItems,
        { type: "separator" },
        { label: "Today…", click: () => this.deps.windows.show("dashboard") },
        { label: "Settings…", click: () => this.deps.windows.show("settings") },
        { label: "Permissions…", click: () => this.deps.windows.show("permissions") },
        { type: "separator" },
        { label: describeBackup(this.deps.backupService, lastError), enabled: false },
        {
          label: "Back up now",
          enabled: this.deps.backupService.getSettings() !== null,
          click: () => {
            void this.deps.onBackupNow();
          },
        },
        { type: "separator" },
        { label: "Quit Time Center", click: () => app.quit() },
      ]),
    );
  }

  /** Swaps the icon for the red-dot one while a call is recorded, and back after. */
  private updateIcon(): void {
    const recording = this.deps.isRecording();
    if (!this.tray || recording === this.showingRecording) {
      return;
    }
    this.showingRecording = recording;
    this.tray.setImage(
      recording ? loadTrayIcon(recordingIconPath, recordingIcon2xPath) : loadTrayIcon(trayIconPath, trayIcon2xPath),
    );
    this.tray.setToolTip(recording ? "Time Center: recording this call" : "Time Center");
  }

  /**
   * Does what a meeting line in the menu was clicked for.
   * @param action The line's action.
   */
  private runMeetingAction(action: MeetingMenuItem["action"]): void {
    if (action?.kind === "skip") {
      this.deps.onSkipMeeting(action.eventId);
    } else if (action?.kind === "join") {
      this.deps.onJoinMeeting(action.eventId);
    } else if (action?.kind === "settings") {
      this.deps.windows.show("settings");
    }
  }
}

/**
 * Writes the meeting lines at the top of the menu: the next meeting that hasn't ended, and what can be
 * done about it — skip the join during its 30-second notice, or join it now.
 * @param signedIn Whether Google Calendar is signed in.
 * @param meetings The coming meetings, soonest first.
 * @param now The current time.
 * @returns The lines.
 */
export function meetingMenuItems(signedIn: boolean, meetings: MeetingInfo[], now: number): MeetingMenuItem[] {
  if (!signedIn) {
    return [{ label: "Meetings: sign in to Google in Settings…", action: { kind: "settings" } }];
  }
  // The one about to be joined first, then the next to start, then one in progress.
  const live = meetings.filter((meeting) => meeting.end > now && meeting.state !== "declined");
  const next =
    live.find((meeting) => meeting.state === "joining") ??
    live.find((meeting) => meeting.start > now) ??
    live[0];
  if (!next) {
    return [{ label: "No meetings in the next day", action: null }];
  }
  const when = new Date(next.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const items: MeetingMenuItem[] = [{ label: `Next: ${next.title} at ${when}${stateNote(next)}`, action: null }];
  if (next.state === "joining" || next.state === "will-join") {
    items.push({ label: `Skip joining ${next.title}`, action: { kind: "skip", eventId: next.eventId } });
  }
  if (next.provider) {
    items.push({ label: `Join ${next.title} now`, action: { kind: "join", eventId: next.eventId } });
  }
  return items;
}

/**
 * Says in a few words what will happen with a meeting.
 * @param meeting The meeting.
 * @returns e.g. " (joins automatically)", or "" when there's nothing to add.
 */
function stateNote(meeting: MeetingInfo): string {
  const notes: Partial<Record<MeetingInfo["state"], string>> = {
    "will-join": " (joins automatically)",
    joining: " (joining in a moment)",
    joined: " (joined)",
    skipped: " (skipped)",
    failed: " (couldn't join)",
    "no-link": " (no meeting link)",
  };
  return notes[meeting.state] ?? "";
}

/**
 * Loads the rabbit-with-a-clock icon (drawn in resources/icon.svg, rendered by `npm run icons`) with its
 * Retina copy, so it stays sharp on every screen. It is a full-colour image, not a macOS "template"
 * image, so the orange background shows in both light and dark menu bars.
 * @param path The 18-point PNG.
 * @param path2x Its Retina copy.
 * @returns The 18-point icon with a 2x representation.
 */
function loadTrayIcon(path: string, path2x: string): NativeImage {
  const icon = nativeImage.createFromPath(path);
  icon.addRepresentation({ scaleFactor: 2, buffer: readFileSync(path2x) });
  return icon;
}

/**
 * Writes the one-line backup status shown in the menu.
 * @param service The backup service.
 * @param lastError The latest error, if the last attempt failed.
 * @returns e.g. "Last backup: Nov 4, 6:00 PM" or "Backup: not set up".
 */
export function describeBackup(service: BackupService, lastError: string | null): string {
  if (!service.getSettings()) {
    return "Backup: not set up";
  }
  if (lastError) {
    return `Backup failed: ${lastError.slice(0, 60)}`;
  }
  const lastSuccessAt = service.getLastSuccessAt();
  if (!lastSuccessAt) {
    return "Last backup: never";
  }
  const when = new Date(lastSuccessAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Last backup: ${when}`;
}
