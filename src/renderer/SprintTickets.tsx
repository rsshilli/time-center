import { useEffect, useState } from "react";
import type { SprintTicket, SprintTicketsReport, TicketMove, TicketSends, TicketWorktrees, TodoActionInfo } from "../shared/ipc";
import { readableError } from "./CalendarSettings";
import { QbdcodeDialog } from "./QbdcodeDialog";
import { sentUrl } from "./sentUrl";

/** How often the list is read again from Jira while the TODO tab is open. */
export const REFRESH_EVERY_MS = 5 * 60_000;

/** The class that colours the status tag for each of Jira's status groups. */
const STATUS_CLASSES: Record<SprintTicket["statusCategory"], string> = { new: "to-do", indeterminate: "doing", done: "done" };

/**
 * The Jira tickets assigned to you in the sprints going now, read when the tab opens, every five minutes, and on
 * Refresh. Each ticket's number opens it in the browser, and its status is a menu to move it to another state;
 * finished ones sit dimmed at the bottom, and merged or released ones aren't listed. Tick one or more to hand them
 * to Claude, as a Cowork task or one QbDCode chat; where each was sent shows under it, as on a TODO.
 */
export function SprintTickets() {
  const [report, setReport] = useState<SprintTicketsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [sends, setSends] = useState<TicketSends>({});
  const [worktrees, setWorktrees] = useState<TicketWorktrees>({});
  const [actions, setActions] = useState<TodoActionInfo[]>([]);
  const [sending, setSending] = useState<string | null>(null);
  const [sendProblem, setSendProblem] = useState<string | null>(null);
  const [qbdcodeKeys, setQbdcodeKeys] = useState<string[] | null>(null);

  /** Reads the list from Jira again. */
  const load = async () => {
    setLoading(true);
    try {
      const latest = await window.timeCenter.getSprintTickets();
      setReport(latest);
      // Branches change without Time Center knowing, so they're read again with every list.
      window.timeCenter.getTicketWorktrees().then(setWorktrees, () => undefined);
      // A ticket that dropped off (merged, say) is unticked, so it doesn't come back ticked later.
      setPicked((current) => current.filter((key) => latest.tickets.some((ticket) => ticket.key === key)));
    } catch (failure) {
      setReport({ tickets: [], sprints: [], problem: readableError(failure) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_EVERY_MS);
    // Where tickets were sent, and whether Claude Desktop and QbDCode are there: the same two a TODO's menu offers.
    window.timeCenter.getTicketSends().then(setSends, () => undefined);
    window.timeCenter.getTodoActions().then(setActions, (failure: unknown) =>
      setSendProblem(`Couldn't check for Claude Desktop and QbDCode: ${readableError(failure)}`),
    );
    return () => clearInterval(timer);
  }, []);

  // A ticket that drops off the list (moved to Merged to Master, say) can't stay picked.
  const listed = report?.tickets.map((ticket) => ticket.key) ?? [];
  const pickedListed = listed.filter((key) => picked.includes(key));

  /**
   * Ticks or unticks a ticket.
   * @param key The ticket.
   * @param on Ticked or not.
   */
  const pick = (key: string, on: boolean) => setPicked((current) => (on ? [...current, key] : current.filter((other) => other !== key)));

  /** Opens a Cowork task in Claude Desktop on the picked tickets. */
  const sendToCowork = async () => {
    setSending("Opening Claude Cowork");
    setSendProblem(null);
    try {
      setSends(await window.timeCenter.sendTicketsToCowork(pickedListed));
      setPicked([]);
    } catch (failure) {
      setSendProblem(readableError(failure));
    } finally {
      setSending(null);
    }
  };

  const cowork = actions.find((action) => action.id === "cowork");
  const qbdcode = actions.find((action) => action.id === "qbdcode");
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
      {(pickedListed.length > 0 || sending || sendProblem) && (
        <div className="sprint-send-bar" role="toolbar" aria-label="Send the ticked tickets">
          {pickedListed.length > 0 && (
            <>
              <span className="muted">
                {pickedListed.length} {pickedListed.length === 1 ? "ticket" : "tickets"} ticked
              </span>
              <button
                type="button"
                className="secondary"
                disabled={sending !== null || Boolean(cowork?.unavailable)}
                title={cowork?.unavailable ?? "A new Cowork task in Claude Desktop, with the tickets filled in"}
                onClick={() => void sendToCowork()}
              >
                Start a Claude Cowork task
              </button>
              {cowork?.unavailable && <span className="muted">— {cowork.unavailable}</span>}
              <button
                type="button"
                className="secondary"
                disabled={sending !== null || Boolean(qbdcode?.unavailable)}
                title={qbdcode?.unavailable ?? "One QbDCode chat on all the ticked tickets"}
                onClick={() => setQbdcodeKeys(pickedListed)}
              >
                Send to QbDCode…
              </button>
              {qbdcode?.unavailable && <span className="muted">— {qbdcode.unavailable}</span>}
              <button type="button" className="link" disabled={sending !== null} onClick={() => setPicked([])}>
                Clear
              </button>
            </>
          )}
          {sending && <span className="muted">{sending}…</span>}
          {sendProblem && <span className="error">{sendProblem}</span>}
        </div>
      )}
      {qbdcodeKeys && (
        <QbdcodeDialog
          prepare={() => window.timeCenter.prepareTicketsQbdcode(qbdcodeKeys)}
          send={async (path, text) => {
            setSends(await window.timeCenter.sendTicketsToQbdcode(qbdcodeKeys, path, text));
            setPicked([]);
          }}
          onClose={() => setQbdcodeKeys(null)}
        />
      )}
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
              <input
                type="checkbox"
                className="sprint-pick"
                checked={picked.includes(ticket.key)}
                aria-label={`Tick ${ticket.key} to send it to Claude`}
                onChange={(event) => pick(ticket.key, event.target.checked)}
              />
              <div className="sprint-ticket-main">
                {/* One run of text, so copying the number and summary gives "QI-123 Summary" on one line. */}
                <span className="sprint-ticket-title">
                  <a href={ticket.url} target="_blank" rel="noopener noreferrer" title={`Open ${ticket.key} in Jira`}>
                    {ticket.key}
                  </a>{" "}
                  <span>{ticket.summary}</span>
                </span>
                {((sends[ticket.key]?.length ?? 0) > 0 || (worktrees[ticket.key]?.length ?? 0) > 0) && (
                  <div className="todo-meta sprint-sent">
                    {(worktrees[ticket.key] ?? []).map((worktree) => (
                      <span key={worktree.path} className="sprint-worktree" title={`Branch ${worktree.branch} in ${worktree.path}`}>
                        ⎇ {worktree.name}
                      </span>
                    ))}
                    {(sends[ticket.key] ?? []).map((sent) => {
                      const url = sentUrl(sent);
                      const when = `Sent ${new Date(sent.at).toLocaleString()}`;
                      return url ? (
                        <a
                          key={`${sent.action}-${sent.at}`}
                          className="todo-sent"
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={sent.action === "cowork" ? `${when}. Opens Cowork in Claude Desktop; the task is in the list down the side.` : when}
                        >
                          {sent.label} ↗
                        </a>
                      ) : (
                        <span key={`${sent.action}-${sent.at}`} className="todo-sent" title={when}>
                          {sent.label}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
              {/* Its own cell, outside the title, so it isn't copied with the number and summary. */}
              <span className={`sprint-type ${typeClass(ticket.type)}`}>{ticket.type}</span>
              <StatusPicker ticket={ticket} onMoved={setReport} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Picks the colour of a ticket's type pill, after Jira's own: bugs red, stories green, tasks blue.
 * @param type The type's name in Jira ("Bug", "Story", "Sub-task"…).
 * @returns The pill's class; other types (Epic…) stay plain.
 */
export function typeClass(type: string): string {
  const name = type.toLowerCase();
  if (name === "bug") {
    return "bug";
  }
  if (name === "story") {
    return "story";
  }
  if (name === "task" || name === "sub-task" || name === "subtask") {
    return "task";
  }
  return "";
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
