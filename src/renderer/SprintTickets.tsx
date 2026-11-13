import { useEffect, useState } from "react";
import type { SprintTicket, SprintTicketsReport, TicketMove } from "../shared/ipc";
import { readableError } from "./CalendarSettings";

/** How often the list is read again from Jira while the TODO tab is open. */
export const REFRESH_EVERY_MS = 5 * 60_000;

/** The class that colours the status tag for each of Jira's status groups. */
const STATUS_CLASSES: Record<SprintTicket["statusCategory"], string> = { new: "to-do", indeterminate: "doing", done: "done" };

/**
 * The Jira tickets assigned to you in the sprints going now, read when the tab opens, every five minutes, and on
 * Refresh. Each ticket's number opens it in the browser, and its status is a menu to move it to another state;
 * finished ones sit dimmed at the bottom, and merged or released ones aren't listed.
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
              {/* One run of text, so copying the number and summary gives "QI-123 Summary" on one line. */}
              <span className="sprint-ticket-title">
                <a href={ticket.url} target="_blank" rel="noopener noreferrer" title={`Open ${ticket.key} in Jira`}>
                  {ticket.key}
                </a>{" "}
                <span title={ticket.type}>{ticket.summary}</span>
              </span>
              <StatusPicker ticket={ticket} onMoved={setReport} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A ticket's status; click it for the states Jira lets it move to, and pick one to move it there. The list is
 * then read again, so a ticket moved to Merged to Master or a release drops off it.
 * @param props.ticket The ticket.
 * @param props.onMoved Takes the list as it is after a move.
 */
function StatusPicker({ ticket, onMoved }: { ticket: SprintTicket; onMoved(report: SprintTicketsReport): void }) {
  const [moves, setMoves] = useState<TicketMove[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** Opens the menu, reading the moves Jira allows from here, or closes it. */
  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setProblem(null);
    setMoves(null);
    try {
      setMoves(await window.timeCenter.listTicketMoves(ticket.key));
    } catch (failure) {
      setProblem(readableError(failure));
    }
  };

  /**
   * Moves the ticket and shows the list as it is after.
   * @param move Where to.
   */
  const pick = async (move: TicketMove) => {
    setBusy(true);
    setProblem(null);
    try {
      onMoved(await window.timeCenter.moveTicket(ticket.key, move.id));
      setOpen(false);
    } catch (failure) {
      setProblem(readableError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="sprint-status-picker" onKeyDown={(event) => event.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        className={`sprint-status ${STATUS_CLASSES[ticket.statusCategory]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Change this ticket's state"
        disabled={busy}
        onClick={() => void toggle()}
      >
        {busy ? "Moving…" : ticket.status} ▾
      </button>
      {open && (
        <span className="sprint-status-menu" role="menu">
          {problem && <span className="error">{problem}</span>}
          {!problem && moves === null && <span className="muted">Asking Jira…</span>}
          {moves?.length === 0 && <span className="muted">Jira offers no other state from here.</span>}
          {moves?.map((move) => (
            <button key={move.id} type="button" role="menuitem" disabled={busy} onClick={() => void pick(move)}>
              <span className={`sprint-dot ${STATUS_CLASSES[move.statusCategory]}`} />
              {move.status}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
