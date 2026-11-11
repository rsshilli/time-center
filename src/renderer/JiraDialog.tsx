import { useCallback, useEffect, useRef, useState } from "react";
import { type JiraDraft, type JiraDraftResult, type JiraSprint, type JiraUser, MAX_JIRA_SUMMARY_CHARS, type Todo } from "../shared/ipc";
import { withRequiredSections } from "../shared/jiraSections";
import { isUnderWay, nextSprint } from "../shared/jiraSprints";
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
  const open = useRef(true);

  /** Has Sonnet write the first draft; run again by "Try again" when it fails. */
  const firstDraft = useCallback(async () => {
    setBusy("drafting");
    setProblem(null);
    try {
      const drafted = await window.timeCenter.draftJiraTicket(todo.id, null, null);
      if (open.current) {
        setResult(drafted);
        setDraft(drafted.draft);
      }
    } catch (failure) {
      if (open.current) {
        setProblem(readableError(failure));
      }
    } finally {
      if (open.current) {
        setBusy(null);
      }
    }
  }, [todo.id]);

  useEffect(() => {
    open.current = true;
    void firstDraft();
    return () => {
      open.current = false;
    };
  }, [firstDraft]);

  useEffect(() => {
    /** Esc closes the popup, unless the ticket is being made or you're typing in a field (so edits aren't lost). */
    const onKey = (event: globalThis.KeyboardEvent) => {
      const inField = event.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName);
      if (event.key === "Escape" && busy !== "creating" && !inField) {
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

  /**
   * Switches the type: swaps in its required sections, and drops a team the new type doesn't offer.
   * @param issueType The new type.
   */
  const changeType = (issueType: string) => {
    if (!draft || !result) {
      return;
    }
    const allowed = result.teamsByType[issueType] ?? [];
    const team = draft.team !== null && allowed.includes(draft.team) ? draft.team : null;
    const keepSprint = team === draft.team && result.sprintTypes.includes(draft.issueType);
    edit({
      issueType,
      description: withRequiredSections(draft.description, issueType),
      team,
      sprint: !result.sprintTypes.includes(issueType) ? null : keepSprint ? draft.sprint : nextSprint(result.sprints, team, Date.now()),
    });
  };

  /**
   * Switches the team, and the sprint to the new team's next one.
   * @param team The team, or null for none.
   */
  const changeTeam = (team: string | null) => {
    if (result && draft) {
      edit({ team, sprint: result.sprintTypes.includes(draft.issueType) ? nextSprint(result.sprints, team, Date.now()) : null });
    }
  };

  const locked = busy !== null;
  const teams = draft && result ? (result.teamsByType[draft.issueType] ?? []) : [];
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
                  onChange={(event) => changeType(event.target.value)}
                >
                  {result.issueTypes.map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label>
                Engineering Team
                <select value={draft.team ?? ""} disabled={locked || teams.length === 0} onChange={(event) => changeTeam(event.target.value || null)}>
                  <option value="">None</option>
                  {teams.map((team) => (
                    <option key={team}>{team}</option>
                  ))}
                </select>
              </label>
              <SprintPicker
                sprints={result.sprints}
                team={draft.team}
                sprint={draft.sprint}
                disabled={locked || !result.sprintTypes.includes(draft.issueType)}
                onPick={(sprint) => edit({ sprint })}
              />
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
        {problem && !draft && busy === null && (
          <button type="button" className="secondary" onClick={() => void firstDraft()}>
            Try again
          </button>
        )}
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
 * The sprint field: the team's sprints first, then everyone else's, and the backlog.
 * @param props.sprints The project's open sprints, earliest first.
 * @param props.team The ticket's team, whose sprints are listed first.
 * @param props.sprint The sprint picked, or null for the backlog.
 * @param props.disabled Whether it can be changed.
 * @param props.onPick Called with the sprint's id, or null for the backlog.
 */
function SprintPicker({
  sprints,
  team,
  sprint,
  disabled,
  onPick,
}: {
  sprints: JiraSprint[];
  team: string | null;
  sprint: number | null;
  disabled: boolean;
  onPick(sprint: number | null): void;
}) {
  const ours = sprints.filter((candidate) => team !== null && candidate.team === team);
  const others = sprints.filter((candidate) => !ours.includes(candidate));
  return (
    <label>
      Sprint
      <select value={sprint ?? ""} disabled={disabled} onChange={(event) => onPick(event.target.value ? Number(event.target.value) : null)}>
        <option value="">Backlog (no sprint)</option>
        {ours.length > 0 && (
          <optgroup label={`${team}'s sprints`}>
            {ours.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {sprintLabel(candidate)}
              </option>
            ))}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label={ours.length > 0 ? "Other sprints" : "Sprints"}>
            {others.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {sprintLabel(candidate)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/**
 * How a sprint reads in the list: its name, then its dates, or "now" for the one under way.
 * @param sprint The sprint.
 * @returns e.g. "PØD-2026-23 · Nov 24 – Dec 8", with "(now)" when its dates say it's under way.
 */
function sprintLabel(sprint: JiraSprint): string {
  /** A date as "Nov 24". */
  const day = (time: number) => new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });
  const dates = sprint.start !== null && sprint.end !== null ? ` · ${day(sprint.start)} – ${day(sprint.end)}` : "";
  return `${sprint.name}${dates}${isUnderWay(sprint, Date.now()) ? " (now)" : ""}`;
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
  // Leaving the box closes the list a moment later (so a click on a name lands first); coming back cancels that.
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (closing.current) {
        clearTimeout(closing.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (query === null || query.trim() === "") {
      setFound([]);
      setProblem(null);
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
        .catch((failure: unknown) => {
          if (current) {
            setProblem(readableError(failure));
          }
        });
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
          onFocus={() => {
            if (closing.current) {
              clearTimeout(closing.current);
            }
            setQuery("");
          }}
          onBlur={() => {
            closing.current = setTimeout(() => setQuery(null), 150);
          }}
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
