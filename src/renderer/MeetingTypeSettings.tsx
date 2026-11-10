import { useEffect, useState } from "react";
import { MEETING_TYPE_LABELS, type MeetingTypeStatus } from "../shared/ipc";
import { readableError } from "./CalendarSettings";

/**
 * How Claude Haiku (on Amazon Bedrock, with your AWS keys) sorts meetings into types, and a button to
 * sort the ones still without a type now rather than at the next calendar sync.
 */
export function MeetingTypeSettings() {
  const [status, setStatus] = useState<MeetingTypeStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    void window.timeCenter.getMeetingTypeStatus().then(setStatus);
  }, []);

  if (!status) {
    return null;
  }

  /** Sorts now and shows how it went. */
  const sortNow = async () => {
    setWorking(true);
    setMessage("Sorting your meetings…");
    try {
      const next = await window.timeCenter.sortMeetingsNow();
      setStatus(next);
      setMessage(next.lastError ? null : "Meetings are sorted.");
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="meeting-type-settings">
      <h1>Meeting types</h1>
      <p className="lead">
        Claude Haiku, on Amazon Bedrock, sorts each meeting into {Object.values(MEETING_TYPE_LABELS).join(", ")}, from
        its name and who's invited. Only the name and the guests' names and email addresses are sent. It uses the AWS
        keys your ~/.bashrc exports. Fix a wrong guess on Today; repeats of that meeting keep your pick.
      </p>
      <dl className="backup-status">
        <dt>AWS keys</dt>
        <dd>{status.via ? `Using ${status.via}` : "Looked up at the first sort"}</dd>
        {status.lastRunAt && (
          <>
            <dt>Last sorted</dt>
            <dd>{new Date(status.lastRunAt).toLocaleTimeString()}</dd>
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
        <button type="button" disabled={working} onClick={() => void sortNow()}>
          Sort meetings now
        </button>
      </div>
      {message && <p className="message">{message}</p>}
    </section>
  );
}
