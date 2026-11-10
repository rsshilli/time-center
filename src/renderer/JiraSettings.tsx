import { useEffect, useState, type FormEvent } from "react";
import type { JiraSettings as Saved } from "../shared/ipc";
import { readableError } from "./CalendarSettings";

/** The form's fields; the token box is empty unless you're replacing the saved one. */
interface JiraForm {
  site: string;
  email: string;
  projectKey: string;
  issueType: string;
  token: string;
}

/**
 * Where a TODO's "Make a Jira ticket" puts the ticket: your Jira site, the email and API token you sign in
 * with, the project and the type of ticket. Saving checks them against Jira first; the token is kept with the
 * Mac's Keychain key and never shown again.
 */
export function JiraSettings() {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [form, setForm] = useState<JiraForm>({ site: "", email: "", projectKey: "", issueType: "", token: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    void window.timeCenter.getJiraSettings().then((settings) => {
      setSaved(settings);
      setForm({ site: settings.site, email: settings.email, projectKey: settings.projectKey, issueType: settings.issueType, token: "" });
    });
  }, []);

  if (!saved) {
    return null;
  }

  /**
   * Checks the settings with Jira and saves them.
   * @param event The form's submit.
   */
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setMessage("Checking with Jira…");
    try {
      const next = await window.timeCenter.saveJiraSettings({ ...form, token: form.token.trim() ? form.token : null });
      setSaved(next);
      setForm({ ...form, site: next.site, projectKey: next.projectKey, token: "" });
      setMessage(`Saved. "Make a Jira ticket" makes a ${next.issueType} in ${next.projectKey}, assigned to you.`);
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setWorking(false);
    }
  };

  /**
   * Updates one field as you type.
   * @param field The field.
   * @returns The change handler.
   */
  const update = (field: keyof JiraForm) => (event: { target: { value: string } }) => setForm({ ...form, [field]: event.target.value });

  return (
    <section className="jira-settings">
      <h1>Jira</h1>
      <p className="lead">
        A TODO's ⋯ menu can make a Jira ticket from it, assigned to you: its first line becomes the summary, the
        whole item (with its formatting and links) the description.
      </p>
      <form className="settings" onSubmit={(event) => void save(event)}>
        <label>
          Jira site
          <input value={form.site} onChange={update("site")} placeholder="https://cherrycircle.atlassian.net" />
        </label>
        <label>
          Your email
          <input value={form.email} onChange={update("email")} placeholder="you@qbdvision.com" />
        </label>
        <label>
          API token (id.atlassian.com → Security → API tokens)
          <input
            type="password"
            autoComplete="off"
            value={form.token}
            onChange={update("token")}
            placeholder={saved.hasToken ? "Saved. Paste a new one to replace it" : "Paste your token"}
          />
        </label>
        <label>
          Project key
          <input value={form.projectKey} onChange={update("projectKey")} placeholder="QI" />
        </label>
        <label>
          Type of ticket
          <input value={form.issueType} onChange={update("issueType")} placeholder="Task" />
        </label>
        <div className="actions">
          <button type="submit" disabled={working}>
            Check and save
          </button>
        </div>
      </form>
      {message && <p className="message">{message}</p>}
    </section>
  );
}
