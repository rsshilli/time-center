import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { joinTarget, type CalendarEvent } from "./meetingLinks";

const run = promisify(execFile);

/** What joining needs, injected for tests. */
export interface MeetingJoinerDeps {
  /** Opens an address with its usual app (Zoom for `zoommtg://`). */
  openExternal(url: string): Promise<void>;
  /** Opens an address in Google Chrome. */
  openInChrome(url: string): Promise<void>;
  /** The calendar's Google account, so Meet opens signed in as it. */
  account(): string | null;
  /** Makes the signed `#tc-join.…` marker for an address, so the extension knows the app opened it. */
  signMarker(url: URL): string;
}

/**
 * Opens a meeting: Zoom meetings straight in the Zoom app, Meet and Teams in Chrome (Edge is never used,
 * since it's ignored), where the companion extension clicks Join.
 */
export class MeetingJoiner {
  /** @param deps How to open addresses. */
  constructor(private readonly deps: MeetingJoinerDeps) {}

  /**
   * Opens the meeting.
   * @param event The meeting; it must have a link.
   */
  async join(event: CalendarEvent): Promise<void> {
    const target = joinTarget(event, this.deps.account(), (url) => this.deps.signMarker(url));
    if (target.app === "zoom") {
      await this.deps.openExternal(target.url);
      return;
    }
    await this.deps.openInChrome(target.url);
  }
}

/**
 * Opens an address in Google Chrome with macOS's `open`, which brings Chrome forward and uses a new tab.
 * @param url The address.
 */
export async function openInChrome(url: string): Promise<void> {
  try {
    await run("open", ["-a", "Google Chrome", url]);
  } catch {
    throw new Error("Couldn't open Google Chrome. Is it installed?");
  }
}
