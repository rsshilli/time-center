import { useEffect, useState } from "react";
import { DashboardScreen } from "./DashboardScreen";
import { startOfDay } from "./day";
import type { Period } from "./period";
import { PermissionsScreen } from "./PermissionsScreen";
import { RecordingsScreen } from "./RecordingsScreen";
import { SettingsScreen } from "./SettingsScreen";
import { TodosScreen } from "./TodosScreen";

/** The screens reachable from the tray, keyed by URL hash. */
type Route = "dashboard" | "recordings" | "todos" | "permissions" | "settings";

/** How often the window checks whether midnight has passed while today is showing. */
const MIDNIGHT_CHECK_MS = 30_000;

/**
 * The app window: a tab bar over whichever screen the tray asked for. The screen lives in the URL hash
 * so the main process can open the window straight onto it. The picked day lives here, so a day picked on
 * the My time tab is the one the Recordings tab shows, and back.
 */
export function App() {
  const [route, setRoute] = useState<Route>(readRoute());
  const [at, setAt] = useState(() => Date.now());
  /** How much the My time tab shows; kept here so it stays put while you visit other tabs. */
  const [period, setPeriod] = useState<Period>("day");

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
    <>
      {/* Outside the page, which is wider on some tabs, so the tabs stay in the same place on every one. */}
      <nav className="tabs">
        <a className={route === "dashboard" ? "active" : ""} href="#/dashboard">
          My time
        </a>
        <a className={route === "recordings" ? "active" : ""} href="#/recordings">
          Recordings
        </a>
        <a className={route === "todos" ? "active" : ""} href="#/todos">
          TODOs
        </a>
        <a className={route === "permissions" ? "active" : ""} href="#/permissions">
          Permissions
        </a>
        <a className={route === "settings" ? "active" : ""} href="#/settings">
          Settings
        </a>
      </nav>
      <main className={wide ? "app wide" : "app"}>
        {route === "dashboard" && <DashboardScreen at={at} onChangeDay={setAt} period={period} onChangePeriod={setPeriod} />}
        {route === "recordings" && <RecordingsScreen at={at} onChangeDay={setAt} />}
        {route === "todos" && (
          <TodosScreen
            onOpenCall={(callAt) => {
              setAt(callAt);
              window.location.hash = "#/recordings";
            }}
          />
        )}
        {route === "permissions" && <PermissionsScreen />}
        {route === "settings" && <SettingsScreen />}
      </main>
    </>
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
    case "#/todos":
      return "todos";
    case "#/permissions":
      return "permissions";
    case "#/settings":
      return "settings";
    default:
      return "dashboard";
  }
}
