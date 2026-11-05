import { useEffect, useState, type FormEvent } from "react";
import type { BackupSettingsInput, BackupStatus } from "../shared/ipc";
import { CalendarSettings } from "./CalendarSettings";
import { IgnoredAppsEditor } from "./IgnoredAppsEditor";
import { MeetingTypeSettings } from "./MeetingTypeSettings";
import { RulesEditor } from "./RulesEditor";

/**
 * Settings for the weekly backup to Amazon S3: which bucket, region and `~/.aws` profile to use, an
 * optional encryption key, when the last backup ran, and a "Back up now" button.
 */
export function SettingsScreen() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [form, setForm] = useState<BackupSettingsInput>({ bucket: "", region: "", profile: "", kmsKeyId: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    void window.timeCenter.getBackupStatus().then((loaded) => {
      setStatus(loaded);
      setForm({ bucket: loaded.bucket, region: loaded.region, profile: loaded.profile, kmsKeyId: loaded.kmsKeyId });
    });
  }, []);

  /**
   * Saves the form. The main process backs up straight away if none has run this week.
   * @param event The form's submit event.
   */
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setStatus(await window.timeCenter.saveBackupSettings(form));
      setMessage(form.bucket.trim() ? "Saved. If no backup has run this week, one starts now." : "Saved. Backups are off.");
    } catch (error) {
      setMessage(`Couldn't save: ${readableError(error)}`);
    }
  };

  /** Backs up now, or waits for the backup already running, then shows how it went. */
  const backUpNow = async () => {
    setWorking(true);
    setMessage("Backing up…");
    try {
      const next = await window.timeCenter.runBackupNow();
      setStatus(next);
      setMessage(next.lastError ? null : "Backup finished.");
    } catch (error) {
      setMessage(`Backup failed: ${readableError(error)}`);
    } finally {
      setWorking(false);
    }
  };

  /** Asks the main process to restore the newest backup; on success the app restarts. */
  const restore = async () => {
    setWorking(true);
    setMessage("Looking for the latest backup…");
    try {
      const result = await window.timeCenter.restoreLatestBackup();
      setMessage(result.status === "failed" ? `Restore failed: ${result.error}` : null);
    } catch (error) {
      setMessage(`Restore failed: ${readableError(error)}`);
    } finally {
      setWorking(false);
    }
  };

  /**
   * Builds the change handler for one form field.
   * @param field The field.
   * @returns The input's onChange handler.
   */
  const update = (field: keyof BackupSettingsInput) => (event: { target: { value: string } }) =>
    setForm({ ...form, [field]: event.target.value });

  return (
    <section>
      <CalendarSettings />
      <MeetingTypeSettings />
      <h1>Weekly backup</h1>
      <p className="lead">
        Once a week, Time Center copies its database (your activity, meetings, transcripts and TODOs) to an
        Amazon S3 bucket, encrypted. Screenshots and meeting audio stay on this Mac. Leave the bucket empty to
        turn backups off.
      </p>

      <form className="settings" onSubmit={(event) => void save(event)}>
        <label>
          S3 bucket
          <input value={form.bucket} onChange={update("bucket")} placeholder="e.g. ryan-time-center-backups" />
        </label>
        <label>
          Region
          <input value={form.region} onChange={update("region")} placeholder="us-east-1" />
        </label>
        <label>
          AWS profile (from ~/.aws)
          <input value={form.profile} onChange={update("profile")} placeholder="default" />
        </label>
        <label>
          KMS key (optional)
          <input value={form.kmsKeyId} onChange={update("kmsKeyId")} placeholder="Leave empty for the account's S3 key" />
        </label>
        <div className="actions">
          <button type="submit">Save</button>
          <button type="button" className="secondary" disabled={!status?.configured || working} onClick={() => void backUpNow()}>
            Back up now
          </button>
          <button type="button" className="secondary" disabled={!status?.configured || working} onClick={() => void restore()}>
            Restore latest backup…
          </button>
        </div>
      </form>

      <dl className="backup-status">
        <dt>Last backup</dt>
        <dd>{status?.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : "Never"}</dd>
        {status?.lastError && (
          <>
            <dt>Last error</dt>
            <dd className="error">{status.lastError}</dd>
          </>
        )}
      </dl>
      {message && <p className="message">{message}</p>}
      <RulesEditor />
      <IgnoredAppsEditor />
    </section>
  );
}

/**
 * Turns an IPC failure into the main process's own message, without Electron's "Error invoking remote
 * method" wrapper.
 * @param error What the IPC call threw.
 * @returns The message to show.
 */
function readableError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
