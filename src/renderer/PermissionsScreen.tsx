import { useCallback, useEffect, useState } from "react";
import type { PermissionKind, PermissionState, PermissionStatus } from "../shared/ipc";

/** Plain-words copy for each permission: what macOS calls it and why the app needs it. */
const COPY: Record<PermissionKind, { title: string; why: string }> = {
  accessibility: {
    title: "Accessibility",
    why: "Lets Time Center read the name of the window you're in, like \"PLAN.md – time-center\".",
  },
  screen: {
    title: "Screen Recording",
    why: "Needed for window names on newer macOS and the once-a-minute screenshots, which stay on this Mac.",
  },
  microphone: {
    title: "Microphone",
    why: "Records your side of a meeting so it can be transcribed on this Mac.",
  },
  automation: {
    title: "Control Google Chrome",
    why: "Lets Time Center read the address of the Chrome tab you're on. Open Chrome first, then press Ask.",
  },
};

/** How each state is shown. */
const STATE_LABEL: Record<PermissionState, string> = {
  granted: "Allowed",
  denied: "Not allowed",
  "not-determined": "Not allowed yet",
  unknown: "Not checked yet",
};

/** How often the screen re-reads permissions, since macOS changes them in a different app. */
const POLL_MS = 2000;

/**
 * Onboarding for the macOS permissions. Each row says what the permission is for, whether it's allowed,
 * and offers "Ask" (macOS's own prompt) and "Open Settings". It refreshes on its own while you flip
 * switches in System Settings.
 */
export function PermissionsScreen() {
  const [statuses, setStatuses] = useState<PermissionStatus[] | null>(null);
  const [busy, setBusy] = useState<PermissionKind | null>(null);

  /** Re-reads every permission from macOS. */
  const refresh = useCallback(async () => {
    setStatuses(await window.timeCenter.getPermissions());
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /**
   * Shows macOS's prompt for one permission, then shows the new states.
   * @param kind The permission.
   */
  const ask = async (kind: PermissionKind) => {
    setBusy(kind);
    try {
      setStatuses(await window.timeCenter.requestPermission(kind));
    } finally {
      setBusy(null);
    }
  };

  if (!statuses) {
    return null;
  }
  const allowedCount = statuses.filter((status) => status.state === "granted").length;

  return (
    <section>
      <h1>Permissions</h1>
      <p className="lead">
        macOS asks once for each of these. {allowedCount} of {statuses.length} allowed. Screen Recording takes
        effect after Time Center restarts: quit it from the orange rabbit icon in the menu bar, then open it again.
      </p>
      <ul className="permissions">
        {statuses.map((status) => (
          <li key={status.kind}>
            <div className="permission-text">
              <strong>{COPY[status.kind].title}</strong>
              <span className="why">{COPY[status.kind].why}</span>
            </div>
            <span className={`badge ${status.state}`}>{STATE_LABEL[status.state]}</span>
            <div className="actions">
              {status.state !== "granted" && (
                <button disabled={busy === status.kind} onClick={() => void ask(status.kind)}>
                  Ask
                </button>
              )}
              <button className="secondary" onClick={() => void window.timeCenter.openPermissionSettings(status.kind)}>
                Open Settings
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
