import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PermissionKind, PermissionState, PermissionStatus } from "../../shared/ipc";

const execFileAsync = promisify(execFile);

/** The parts of Electron's `systemPreferences` and `shell` this class uses, injected for tests. */
export interface PermissionsPlatform {
  /** Whether Accessibility is allowed; with `prompt`, also shows macOS's prompt. */
  isTrustedAccessibilityClient(prompt: boolean): boolean;
  /** macOS's answer for a media permission: "granted", "denied", "not-determined", … */
  getMediaAccessStatus(mediaType: "microphone" | "screen"): string;
  /** Shows macOS's microphone prompt. */
  askForMediaAccess(mediaType: "microphone"): Promise<boolean>;
  /** Tries one screen capture, which makes macOS list the app under Screen Recording and prompt once. */
  requestScreenCapture(): Promise<void>;
  /** Opens a URL, here a System Settings pane. */
  openExternal(url: string): Promise<void>;
  /** Runs an AppleScript and returns what it printed. */
  runAppleScript(script: string): Promise<string>;
  /**
   * macOS's saved answer for controlling Chrome, read without ever prompting: "granted", "denied",
   * "not-determined", "not-running" (macOS can only say while Chrome is open) or "unknown …".
   */
  readChromeAutomation(): Promise<string>;
}

/** Keeps Chrome's last known Automation answer across restarts, for when Chrome isn't open to ask. */
export interface AutomationMemory {
  load(): string | null;
  save(state: PermissionState): void;
}

/** The answers worth remembering; "unknown" never replaces a real one. */
const KNOWN_STATES: readonly PermissionState[] = ["granted", "denied", "not-determined"];

/** The System Settings pane for each permission. */
const SETTINGS_URLS: Record<PermissionKind, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
};

/** AppleScript error number for "not authorized to send Apple events". */
const APPLE_EVENTS_NOT_AUTHORIZED = "-1743";

/**
 * Asks Chrome for nothing more than its window count. Guarded so it never launches Chrome. If Chrome is
 * running, the first call makes macOS show the "allow Time Center to control Chrome" prompt.
 */
const CHROME_PROBE = `if application "Google Chrome" is running then
  tell application "Google Chrome" to return (count of windows) as text
else
  return "not-running"
end if`;

/**
 * Reads and requests the macOS permissions the app needs: Accessibility (window titles), Screen
 * Recording (titles on newer macOS, screenshots), Microphone, and Automation for Chrome (tab URLs).
 * macOS shows its own prompts; this class triggers them and opens the right Settings pane.
 */
export class Permissions {
  private automationState: PermissionState;
  private screenCaptureTried = false;

  /**
   * @param platform Electron's APIs, or fakes in tests.
   * @param memory Where Chrome's last known answer is kept; nowhere by default.
   */
  constructor(
    private readonly platform: PermissionsPlatform,
    private readonly memory: AutomationMemory = { load: () => null, save: () => undefined },
  ) {
    const saved = memory.load() as PermissionState | null;
    this.automationState = saved !== null && KNOWN_STATES.includes(saved) ? saved : "unknown";
  }

  /**
   * Reads macOS's saved answer for controlling Chrome, without prompting. Run at launch and whenever the
   * Permissions tab asks, so an answer given once isn't shown as "Not checked yet" after every restart.
   * While Chrome is closed macOS can't say, so the last known answer stays.
   */
  async refreshAutomation(): Promise<void> {
    const answer = await this.platform.readChromeAutomation().catch(() => "unknown");
    this.setAutomation(answer.trim() as PermissionState);
  }

  /**
   * Reports every permission's current state. Accessibility and Screen Recording are yes/no checks on
   * macOS, which can't tell "never asked" from "turned off", so "no" is reported as not yet allowed.
   * @returns One status per permission, in display order.
   */
  getAll(): PermissionStatus[] {
    const screen = mapMediaStatus(this.platform.getMediaAccessStatus("screen"));
    return [
      { kind: "accessibility", state: this.platform.isTrustedAccessibilityClient(false) ? "granted" : "not-determined" },
      { kind: "screen", state: screen === "denied" ? "not-determined" : screen },
      { kind: "microphone", state: mapMediaStatus(this.platform.getMediaAccessStatus("microphone")) },
      { kind: "automation", state: this.automationState },
    ];
  }

  /**
   * Says whether any permission still needs the user's attention, used to decide whether to open
   * onboarding at launch. Automation's "unknown" doesn't count, because macOS can't be asked about it.
   * @returns True when something is denied or not yet decided.
   */
  needsAttention(): boolean {
    return this.getAll().some((status) => status.state === "denied" || status.state === "not-determined");
  }

  /**
   * Triggers macOS's own prompt for a permission. For Screen Recording macOS only prompts on the first
   * capture attempt, so a second "Ask" opens its Settings pane instead.
   * @param kind The permission.
   * @returns Every permission's state afterwards.
   */
  async request(kind: PermissionKind): Promise<PermissionStatus[]> {
    if (kind === "accessibility") {
      this.platform.isTrustedAccessibilityClient(true);
    } else if (kind === "microphone") {
      await this.platform.askForMediaAccess("microphone");
    } else if (kind === "automation") {
      await this.probeChromeAutomation();
    } else if (!this.screenCaptureTried) {
      this.screenCaptureTried = true;
      await this.platform.requestScreenCapture();
    } else {
      await this.openSettings(kind);
    }
    return this.getAll();
  }

  /**
   * Opens System Settings at the pane for a permission.
   * @param kind The permission.
   */
  async openSettings(kind: PermissionKind): Promise<void> {
    await this.platform.openExternal(SETTINGS_URLS[kind]);
  }

  /**
   * Talks to Chrome once to learn (and, the first time, ask for) the Automation permission.
   */
  private async probeChromeAutomation(): Promise<void> {
    try {
      const output = await this.platform.runAppleScript(CHROME_PROBE);
      this.setAutomation(output.trim() === "not-running" ? "unknown" : "granted");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.setAutomation(text.includes(APPLE_EVENTS_NOT_AUTHORIZED) ? "denied" : "unknown");
    }
  }

  /**
   * Takes a real answer about Chrome and remembers it; anything else leaves the last known one.
   * @param state What was learned.
   */
  private setAutomation(state: PermissionState): void {
    if (!KNOWN_STATES.includes(state)) {
      return;
    }
    this.automationState = state;
    this.memory.save(state);
  }
}

/**
 * Maps Electron's media access status to the app's permission states.
 * @param status "granted", "denied", "restricted", "not-determined" or "unknown".
 * @returns The app's state.
 */
export function mapMediaStatus(status: string): PermissionState {
  if (status === "granted") {
    return "granted";
  }
  if (status === "not-determined") {
    return "not-determined";
  }
  if (status === "denied" || status === "restricted") {
    return "denied";
  }
  return "unknown";
}

/**
 * Runs an AppleScript with `osascript`.
 * @param script The script source.
 * @returns What the script printed.
 */
export async function runAppleScript(script: string): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 15_000 });
  return stdout;
}

/**
 * Asks the front-window helper for macOS's saved Chrome Automation answer. The helper is our own child, so
 * macOS answers for Time Center, and it never prompts.
 * @param helper The active-window helper's path.
 * @returns e.g. "granted" or "not-running".
 */
export async function readAutomationStatus(helper: string): Promise<string> {
  const { stdout } = await execFileAsync(helper, ["--automation-status", "com.google.Chrome"], { timeout: 5_000 });
  return stdout;
}
