import { useEffect, useState } from "react";
import type { QbdcodeHandoff, Todo } from "../shared/ipc";
import { readableError } from "./CalendarSettings";

/**
 * The popup that hands an item to a new QbDCode chat: the instructions, written from the item and its call and
 * ready to edit, and the qbdvision worktree the chat works in. Nothing starts until "Send".
 * @param props.todo The item.
 * @param props.onClose Closes the popup without sending anything.
 * @param props.onSent Called with the list once the chat is queued and recorded on the item.
 */
export function QbdcodeDialog({ todo, onClose, onSent }: { todo: Todo; onClose(): void; onSent(todos: Todo[]): void }) {
  const [handoff, setHandoff] = useState<QbdcodeHandoff | null>(null);
  const [text, setText] = useState("");
  const [path, setPath] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    window.timeCenter
      .prepareQbdcodeHandoff(todo.id)
      .then((prepared) => {
        if (current) {
          setHandoff(prepared);
          setText(prepared.text);
          setPath(prepared.worktrees[0]?.path ?? "");
        }
      })
      .catch((failure: unknown) => {
        if (current) {
          setProblem(readableError(failure));
        }
      });
    return () => {
      current = false;
    };
  }, [todo.id]);

  useEffect(() => {
    /** Esc closes the popup, unless the chat is being started or you're typing in a field (so edits aren't lost). */
    const onKey = (event: globalThis.KeyboardEvent) => {
      const inField = event.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName);
      if (event.key === "Escape" && !sending && !inField) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sending, onClose]);

  /** Starts the chat and closes the popup. */
  const send = async () => {
    if (!handoff || sending || text.trim() === "" || path === "") {
      return;
    }
    setSending(true);
    setProblem(null);
    try {
      onSent(await window.timeCenter.sendToQbdcode(todo.id, path, text));
      onClose();
    } catch (failure) {
      setProblem(readableError(failure));
      setSending(false);
    }
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog qbdcode-dialog" role="dialog" aria-modal="true" aria-labelledby="qbdcode-dialog-title">
        <h2 id="qbdcode-dialog-title">Send to QbDCode</h2>
        {!handoff && !problem && <p className="muted">Writing the instructions…</p>}
        {handoff && (
          <div className="jira-fields">
            <label className="wide">
              Worktree
              <select value={path} disabled={sending} onChange={(event) => setPath(event.target.value)}>
                {handoff.worktrees.map((worktree) => (
                  <option key={worktree.path} value={worktree.path}>
                    {worktree.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              Instructions
              <textarea value={text} rows={16} disabled={sending} onChange={(event) => setText(event.target.value)} />
            </label>
          </div>
        )}
        {problem && <p className="error">{problem}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={sending} onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={!handoff || sending || text.trim() === "" || path === ""} onClick={() => void send()}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
