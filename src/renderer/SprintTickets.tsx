import { useEffect, useState } from "react";
import type { SprintTicket, SprintTicketsReport } from "../shared/ipc";
import { readableError } from "./CalendarSettings";

/** How often the list is read again from Jira while the TODO tab is open. */
export const REFRESH_EVERY_MS = 5 * 60_000;

/** The class that colours the status tag for each of Jira's status groups. */
const STATUS_CLASSES: Record<SprintTicket["statusCategory"], string> = { new: "to-do", indeterminate: "doing", done: "done" };

/**
 * The Jira tickets assigned to you in the sprints going now, read when the tab opens, every five minutes, and on
 * Refresh. Each ticket's number opens it in the browser; finished ones sit dimmed at the bottom.
 */
export function SprintTickets() {
  const [report, setReport] = useState<SprintTicketsReport | null>(null);
  const [loading, setLoading] = useState(false);

  /** Reads the list from Jira again. */
  const load = async () => {
    setLoading(true);
    try {
      setReport(await window.timeCenter.getSprintTickets());
    } catch (failure) {
      setReport({ tickets: [], sprints: [], problem: readableError(failure) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_EVERY_MS);
    return () => clearInterval(timer);
  }, []);

  const open = report?.tickets.filter((ticket) => ticket.statusCategory !== "done").length ?? 0;
  return (
    <section className="todo-section sprint-tickets" aria-label="Jira: this sprint">
      <h2>
        Jira · {report && report.sprints.length > 0 ? report.sprints.join(", ") : "this sprint"}{" "}
        {report && !report.problem && <span className="muted">{open}</span>}
        <button type="button" className="link sprint-refresh" disabled={loading} onClick={() => void load()}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      </h2>
      {report === null ? (
        <p className="muted todo-empty">Reading your tickets from Jira…</p>
      ) : report.problem ? (
        <p className="muted todo-empty">Couldn't read your sprint tickets. {report.problem}</p>
      ) : report.tickets.length === 0 ? (
        <p className="muted todo-empty">Nothing assigned to you in a sprint that's going now.</p>
      ) : (
        <ul className="sprint-ticket-list">
          {report.tickets.map((ticket) => (
            <li key={ticket.key} className={ticket.statusCategory === "done" ? "sprint-ticket done" : "sprint-ticket"}>
              <a href={ticket.url} target="_blank" rel="noopener noreferrer" title={`Open ${ticket.key} in Jira`}>
                {ticket.key}
              </a>
              <span className="sprint-ticket-summary" title={ticket.type}>
                {ticket.summary}
              </span>
              <span className={`sprint-status ${STATUS_CLASSES[ticket.statusCategory]}`}>{ticket.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
