import { useEffect, useState } from "react";
import type { CalendarStatus, MeetingInfo } from "../shared/ipc";

/** How often the meeting list refreshes while Settings is open, so states and countdowns stay current. */
const REFRESH_EVERY_MS = 10_000;

/** Plain words for each meeting state. */
const STATE_TEXT: Record<MeetingInfo["state"], string> = {
  "will-join": "Joins automatically",
  joining: "Joining in a moment",
  joined: "Joined",
  skipped: "Skipped",
  failed: "Couldn't join",
  missed: "Missed (Mac was asleep)",
  "no-link": "No meeting link",
  declined: "You declined",
  "auto-join-off": "Auto-join is off",
};

/** The services' names as people say them. */
const PROVIDER_TEXT = { meet: "Google Meet", zoom: "Zoom", teams: "Teams" } as const;

/**
 * Google Calendar and auto-join: sign in, turn automatic joining on or off, see the coming meetings with
 * what will happen to each (skip one, or join it now).
 */
export function CalendarSettings() {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    /** Reloads the status. */
    const load = () => void window.timeCenter.getCalendarStatus().then(setStatus);
    load();
    const timer = setInterval(load, REFRESH_EVERY_MS);
    return () => clearInterval(timer);
  }, []);

  if (!status) {
    return null;
  }

  /**
   * Runs a calendar action, shows its result, and turns any failure into a message.
   * @param action The call.
   * @param busyText What to say while it runs, if it takes a while.
   */
  const run = async (action: () => Promise<CalendarStatus>, busyText: string | null = null) => {
    setWorking(true);
    setMessage(busyText);
    try {
      setStatus(await action());
      setMessage(null);
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="calendar-settings">
      <h1>Meetings</h1>
      <p className="lead">
        Time Center reads your main Google calendar (read-only) and joins each meeting 30 seconds before it
        starts, unless you declined it. A notice shows 30 seconds before that; click it to skip.
      </p>

      <dl className="backup-status">
        <dt>Google Calendar</dt>
        <dd>{status.signedIn ? `Signed in${status.account ? ` as ${status.account}` : ""}` : "Not signed in"}</dd>
        {status.signedIn && (
          <>
            <dt>Last read</dt>
            <dd>{status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString() : "Not yet"}</dd>
          </>
        )}
        {status.lastError && (
          <>
            <dt>Last error</dt>
            <dd className="error">{status.lastError}</dd>
          </>
        )}
      </dl>

      <div className="actions">
        {!status.hasClient && (
          <button className="secondary" disabled={working} onClick={() => void run(() => window.timeCenter.chooseGoogleClient())}>
            Choose Google client file…
          </button>
        )}
        {status.signedIn ? (
          <button className="secondary" disabled={working} onClick={() => void run(() => window.timeCenter.signOutOfGoogle())}>
            Sign out of Google
          </button>
        ) : (
          <button
            disabled={working || !status.hasClient}
            onClick={() => void run(() => window.timeCenter.signInToGoogle(), "Finish signing in in your browser…")}
          >
            Sign in with Google
          </button>
        )}
        <label className="toggle">
          <input
            type="checkbox"
            checked={status.autoJoin}
            disabled={working}
            onChange={(event) => void run(() => window.timeCenter.setAutoJoin(event.target.checked))}
          />
          Join meetings automatically
        </label>
      </div>
      {!status.hasClient && (
        <p className="hint">This build has no Google client built in. Choose the Time Center credentials.json first.</p>
      )}
      {message && <p className="message">{message}</p>}

      {status.signedIn && (
        <table className="meetings">
          <tbody>
            {status.meetings.length === 0 && (
              <tr>
                <td className="muted">No meetings in the next day.</td>
              </tr>
            )}
            {status.meetings.map((meeting) => (
              <tr key={`${meeting.eventId}@${meeting.start}`}>
                <td className="meeting-time">{formatTime(meeting.start)}</td>
                <td>
                  {meeting.title}
                  <span className="muted"> · {meeting.provider ? PROVIDER_TEXT[meeting.provider] : "no link"}</span>
                </td>
                <td className={`meeting-state ${meeting.state}`}>{STATE_TEXT[meeting.state]}</td>
                <td className="meeting-actions">
                  {(meeting.state === "will-join" || meeting.state === "joining") && (
                    <button className="secondary" disabled={working} onClick={() => void run(() => window.timeCenter.skipMeeting(meeting.eventId))}>
                      Skip
                    </button>
                  )}
                  {meeting.provider && (
                    <button className="secondary" disabled={working} onClick={() => void run(() => window.timeCenter.joinMeetingNow(meeting.eventId))}>
                      Join now
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="hint">
        Zoom meetings open straight in the Zoom app. Meet and Teams open in Chrome on the meeting's page, where
        you click Join.
      </p>
    </section>
  );
}

/**
 * Shows a meeting's start as a short day and time.
 * @param ms The start.
 * @returns e.g. "Today 10:00 AM" or "Fri 9:30 AM".
 */
function formatTime(ms: number): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const isToday = date.toDateString() === new Date().toDateString();
  return `${isToday ? "Today" : date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/**
 * Turns an IPC failure into the main process's own message.
 * @param error What the IPC call threw.
 * @returns The message to show.
 */
export function readableError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
