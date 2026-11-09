import { useEffect, useState } from "react";
import { DashboardScreen } from "./DashboardScreen";
import { startOfDay } from "./day";
import { PermissionsScreen } from "./PermissionsScreen";
import { RecordingsScreen } from "./RecordingsScreen";
import { SettingsScreen } from "./SettingsScreen";

/** The screens reachable from the tray, keyed by URL hash. */
type Route = "dashboard" | "recordings" | "permissions" | "settings";

/** How often the window checks whether midnight has passed while today is showing. */
const MIDNIGHT_CHECK_MS = 30_000;

/**
 * The app window: a tab bar over whichever screen the tray asked for. The screen lives in the URL hash
 * so the main process can open the window straight onto it. The picked day lives here, so a day picked on
 * the Today tab is the one the Recordings tab shows, and back.
 */
export function App() {
  const [route, setRoute] = useState<Route>(readRoute());
  const [at, setAt] = useState(() => Date.now());

  useEffect(() => {
    /** Follows the tab links and the tray's screen switches. */
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    let today = startOfDay(Date.now());
    const timer = setInterval(() => {
      const now = Date.now();
      // Left open past midnight on today, the window moves on to the new day rather than staying on yesterday.
      if (startOfDay(now) !== today) {
        setAt((current) => (startOfDay(current) === today ? now : current));
        today = startOfDay(now);
      }
    }, MIDNIGHT_CHECK_MS);
    return () => clearInterval(timer);
  }, []);

  const wide = route === "dashboard" || route === "recordings";
  return (
    <div className={wide ? "app wide" : "app"}>
      <nav className="tabs">
        <a className={route === "dashboard" ? "active" : ""} href="#/dashboard">
          Today
        </a>
        <a className={route === "recordings" ? "active" : ""} href="#/recordings">
          Recordings
        </a>
        <a className={route === "permissions" ? "active" : ""} href="#/permissions">
          Permissions
        </a>
        <a className={route === "settings" ? "active" : ""} href="#/settings">
          Settings
        </a>
      </nav>
      <main>
        {route === "dashboard" && <DashboardScreen at={at} onChangeDay={setAt} />}
        {route === "recordings" && <RecordingsScreen at={at} onChangeDay={setAt} />}
        {route === "permissions" && <PermissionsScreen />}
        {route === "settings" && <SettingsScreen />}
      </main>
    </div>
  );
}

/**
 * Reads the screen from the URL hash.
 * @returns The route, defaulting to the dashboard.
 */
function readRoute(): Route {
  switch (window.location.hash) {
    case "#/recordings":
      return "recordings";
    case "#/permissions":
      return "permissions";
    case "#/settings":
      return "settings";
    default:
      return "dashboard";
  }
}
