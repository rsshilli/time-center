import { useEffect, useState } from "react";
import { type JiraDraft, type JiraDraftResult, type JiraUser, MAX_JIRA_SUMMARY_CHARS, type Todo } from "../shared/ipc";
import { withRequiredSections } from "../shared/jiraSections";
import { QuestionInput } from "./AskCard";
import { readableError } from "./CalendarSettings";

/** How long typing in the assignee box pauses before Jira is searched. */
const SEARCH_DELAY_MS = 250;

/** What the popup is busy with, as shown on its buttons. */
type Busy = "drafting" | "changing" | "creating" | null;

/**
 * The popup that makes a Jira ticket from an item. Sonnet proposes the type, summary, description, assignee and
 * Engineering Team; every field can be edited, and the box at the bottom asks Sonnet to change the proposal.
 * Nothing is sent to Jira until "Create ticket".
 * @param props.todo The item.
 * @param props.onClose Closes the popup without making anything.
 * @param props.onCreated Called with the list once the ticket is made and recorded on the item.
 */
export function JiraDialog({ todo, onClose, onCreated }: { todo: Todo; onClose(): void; onCreated(todos: Todo[]): void }) {
  const [result, setResult] = useState<JiraDraftResult | null>(null);
  const [draft, setDraft] = useState<JiraDraft | null>(null);
  const [busy, setBusy] = useState<Busy>("drafting");
  const [problem, setProblem] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    let current = true;
    window.timeCenter
      .draftJiraTicket(todo.id, null, null)
      .then((drafted) => {
        if (current) {
          setResult(drafted);
          setDraft(drafted.draft);
        }
      })
      .catch((failure: unknown) => current && setProblem(readableError(failure)))
      .finally(() => current && setBusy(null));
    return () => {
      current = false;
    };
  }, [todo.id]);

  useEffect(() => {
    /** Esc closes the popup, unless the ticket is being made. */
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && busy !== "creating") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  /** Asks Sonnet to change the proposal as typed, keeping the edits made by hand. */
  const change = async () => {
    if (!draft || busy !== null || instruction.trim() === "") {
      return;
    }
    setBusy("changing");
    setProblem(null);
    try {
      const changed = await window.timeCenter.draftJiraTicket(todo.id, draft, instruction);
      setResult(changed);
      setDraft(changed.draft);
      setInstruction("");
    } catch (failure) {
      setProblem(readableError(failure));
    } finally {
      setBusy(null);
    }
  };

  /** Makes the ticket and closes the popup. */
  const create = async () => {
    if (!draft || busy !== null) {
      return;
    }
    setBusy("creating");
    setProblem(null);
    try {
      onCreated(await window.timeCenter.createJiraTicket(todo.id, draft));
      onClose();
    } catch (failure) {
      setProblem(readableError(failure));
      setBusy(null);
    }
  };

  /**
   * Changes one field of the proposal.
   * @param fields The fields to change.
   */
  const edit = (fields: Partial<JiraDraft>) => setDraft((before) => (before ? { ...before, ...fields } : before));

  const locked = busy !== null;
  return (
    <div className="dialog-backdrop">
      <div className="dialog jira-dialog" role="dialog" aria-modal="true" aria-labelledby="jira-dialog-title">
        <h2 id="jira-dialog-title">Make a Jira ticket</h2>
        {busy === "drafting" && <p className="muted">Sonnet is drafting the ticket…</p>}
        {draft && result && (
          <>
            {result.note && <p className="jira-note">{result.note}</p>}
            <div className="jira-fields">
              <label>
                Type
                <select
                  value={draft.issueType}
                  disabled={locked}
                  onChange={(event) => edit({ issueType: event.target.value, description: withRequiredSections(draft.description, event.target.value) })}
                >
                  {result.issueTypes.map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label>
                Engineering Team
                <select value={draft.team ?? ""} disabled={locked || result.teams.length === 0} onChange={(event) => edit({ team: event.target.value || null })}>
                  <option value="">None</option>
                  {result.teams.map((team) => (
                    <option key={team}>{team}</option>
                  ))}
                </select>
              </label>
              <AssigneePicker assignee={draft.assignee} disabled={locked} onPick={(assignee) => edit({ assignee })} />
              <label className="wide">
                Summary
                <input value={draft.summary} maxLength={MAX_JIRA_SUMMARY_CHARS} disabled={locked} onChange={(event) => edit({ summary: event.target.value })} />
              </label>
              <label className="wide">
                <span>
                  Description <span className="muted">(Markdown)</span>
                </span>
                <textarea value={draft.description} rows={9} disabled={locked} onChange={(event) => edit({ description: event.target.value })} />
              </label>
            </div>
            <div className="jira-change">
              <QuestionInput
                question={instruction}
                setQuestion={(update) => setInstruction(update)}
                onAsk={() => void change()}
                onError={setProblem}
                asking={locked}
                placeholder="Ask Sonnet to change it, e.g. make it a story for Platform with sharper acceptance criteria"
                label="What Sonnet should change"
              />
              <button type="button" disabled={locked || instruction.trim() === ""} onClick={() => void change()}>
                {busy === "changing" ? "Changing…" : "Change"}
              </button>
            </div>
          </>
        )}
        {problem && <p className="error">{problem}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy === "creating"} onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={!draft || locked || draft.summary.trim() === ""} onClick={() => void create()}>
            {busy === "creating" ? "Creating…" : "Create ticket"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The assignee field: shows who it's assigned to, and searches Jira for someone else as you type.
 * @param props.assignee Who it's assigned to, or null for nobody.
 * @param props.disabled Whether it can be changed.
 * @param props.onPick Called with the person picked, or null for unassigned.
 */
function AssigneePicker({ assignee, disabled, onPick }: { assignee: JiraUser | null; disabled: boolean; onPick(user: JiraUser | null): void }) {
  const [query, setQuery] = useState<string | null>(null);
  const [found, setFound] = useState<JiraUser[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (query === null || query.trim() === "") {
      setFound([]);
      return undefined;
    }
    let current = true;
    const timer = setTimeout(() => {
      window.timeCenter
        .searchJiraUsers(query)
        .then((users) => {
          if (current) {
            setFound(users);
            setProblem(null);
          }
        })
        .catch((failure: unknown) => current && setProblem(readableError(failure)));
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query]);

  /**
   * Picks someone and closes the search.
   * @param user The person, or null for unassigned.
   */
  const pick = (user: JiraUser | null) => {
    onPick(user);
    setQuery(null);
  };

  return (
    <div className="jira-assignee">
      <label>
        Assignee
        <input
          value={query ?? assignee?.displayName ?? ""}
          placeholder={query === null ? "Unassigned" : "Type a name"}
          disabled={disabled}
          onFocus={() => setQuery("")}
          onBlur={() => setTimeout(() => setQuery(null), 150)}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {query !== null && (
        <div className="jira-assignee-list">
          {found.map((user) => (
            <button key={user.accountId} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => pick(user)}>
              {user.displayName}
            </button>
          ))}
          {query.trim() !== "" && found.length === 0 && !problem && <span className="muted">No one in the project matches.</span>}
          {problem && <span className="error">{problem}</span>}
          <button type="button" className="jira-unassigned" onMouseDown={(event) => event.preventDefault()} onClick={() => pick(null)}>
            Unassigned
          </button>
        </div>
      )}
    </div>
  );
}
