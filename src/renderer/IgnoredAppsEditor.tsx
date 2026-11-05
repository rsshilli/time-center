import { useEffect, useState } from "react";

/**
 * Edits the apps Time Center never looks at. While one is in front its time shows only as "Untracked",
 * and a screen showing any of its windows is left out of the minute screenshots.
 */
export function IgnoredAppsEditor() {
  const [apps, setApps] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void window.timeCenter.getIgnoredApps().then(setApps);
  }, []);

  if (!apps) {
    return null;
  }

  /**
   * Changes one row.
   * @param index The row's position.
   * @param value Its new text.
   */
  const edit = (index: number, value: string) => {
    setApps(apps.map((app, position) => (position === index ? value : app)));
    setMessage(null);
  };

  /** Saves the list; the main process trims it and drops blanks and repeats. */
  const save = async () => {
    try {
      const saved = await window.timeCenter.saveIgnoredApps(apps);
      setApps(saved);
      setMessage(
        saved.length === 0
          ? "Saved. No apps are ignored now: every app's titles, addresses and screens are recorded."
          : "Saved. Takes effect within a few seconds.",
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(`Couldn't save: ${text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
    }
  };

  return (
    <section className="ignored-apps">
      <h1>Ignored apps</h1>
      <p className="lead">
        Time Center never reads these apps' window titles or web addresses, and leaves out of its screenshots
        any screen showing one of their windows. Their time shows only as "Untracked". Enter an app's name as
        it appears in the menu bar, or its bundle id: <code>com.microsoft.edgemac</code> covers every edition of
        Edge and its web apps.
      </p>
      <div className="settings">
        {apps.map((app, index) => (
          <div className="ignored-app" key={index}>
            <input
              value={app}
              onChange={(event) => edit(index, event.target.value)}
              placeholder="e.g. Signal or com.microsoft.edgemac"
              aria-label="App name or bundle id"
            />
            <button
              className="secondary"
              onClick={() => setApps(apps.filter((_, position) => position !== index))}
              aria-label="Remove app"
            >
              ✕
            </button>
          </div>
        ))}
        <div className="actions">
          <button className="secondary" onClick={() => setApps([...apps, ""])}>
            Add app
          </button>
          <button onClick={() => void save()}>Save ignored apps</button>
        </div>
      </div>
      {message && <p className="message">{message}</p>}
    </section>
  );
}
