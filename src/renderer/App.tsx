import { useEffect, useState } from "react";
import { PermissionsScreen } from "./PermissionsScreen";
import { SettingsScreen } from "./SettingsScreen";

/** The screens reachable from the tray, keyed by URL hash. */
type Route = "permissions" | "settings";

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
    <div className="app">
      <nav className="tabs">
        <a className={route === "permissions" ? "active" : ""} href="#/permissions">
          Permissions
        </a>
        <a className={route === "settings" ? "active" : ""} href="#/settings">
          Settings
        </a>
      </nav>
      <main>{route === "permissions" ? <PermissionsScreen /> : <SettingsScreen />}</main>
    </div>
  );
}

/**
 * Reads the screen from the URL hash.
 * @returns The route, defaulting to settings.
 */
function readRoute(): Route {
  return window.location.hash === "#/permissions" ? "permissions" : "settings";
}
