import { useEffect, useState } from "react";
import { DashboardScreen } from "./DashboardScreen";
import { PermissionsScreen } from "./PermissionsScreen";
import { SettingsScreen } from "./SettingsScreen";

/** The screens reachable from the tray, keyed by URL hash. */
type Route = "dashboard" | "permissions" | "settings";

/**
 * The app window: a tab bar over whichever screen the tray asked for. The screen lives in the URL hash
 * so the main process can open the window straight onto it.
 */
export function App() {
  const [route, setRoute] = useState<Route>(readRoute());

  useEffect(() => {
    /** Follows the tab links and the tray's screen switches. */
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className={route === "dashboard" ? "app wide" : "app"}>
      <nav className="tabs">
        <a className={route === "dashboard" ? "active" : ""} href="#/dashboard">
          Today
        </a>
        <a className={route === "permissions" ? "active" : ""} href="#/permissions">
          Permissions
        </a>
        <a className={route === "settings" ? "active" : ""} href="#/settings">
          Settings
        </a>
      </nav>
      <main>
        {route === "dashboard" && <DashboardScreen />}
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
  if (window.location.hash === "#/permissions") {
    return "permissions";
  }
  return window.location.hash === "#/settings" ? "settings" : "dashboard";
}
