import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type { CallQuestion, CallQuestionScope, CallQuestionTodo, CallRecording } from "../shared/ipc";
import { readableError } from "./CalendarSettings";
import { startOfDay } from "./day";
import { DictationButton } from "./DictationButton";
import { formatClock, formatDay } from "./format";
import { escapeMarkdown } from "./todoOrder";

/** How often the call picker re-reads the day's calls. */
const CALLS_REFRESH_MS = 15_000;

/** Each scope's name in the picker. */
const SCOPE_TEXT: Record<CallQuestionScope, string> = { call: "This call", day: "This day", all: "All calls" };

/**
 * The question box on the Recordings tab: ask Sonnet about one call, the picked day's calls, or every call
 * that mentions your words. Type or dictate the question; past questions and answers are listed below it.
 * @param props.at A moment in the picked day.
 */
export function AskCard({ at }: { at: number }) {
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<CallQuestionScope>("call");
  const [calls, setCalls] = useState<CallRecording[]>([]);
  const [recordingId, setRecordingId] = useState<number | null>(null);
  const [history, setHistory] = useState<CallQuestion[]>([]);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Questions asked since the day was picked stay listed even when their calls were on other days.
  const [justAsked, setJustAsked] = useState<number[]>([]);
  const dayStart = startOfDay(at);

  useEffect(() => setJustAsked([]), [dayStart]);

  useEffect(() => {
    void window.timeCenter
      .getCallQuestions()
      .then(setHistory)
      .catch((caught: unknown) => setProblem(`Couldn't load your past questions: ${readableError(caught)}`));
  }, []);

  /** Reads the picked day's calls for the call picker, keeping the chosen call if it's still there. */
  const loadCalls = useCallback(async () => {
    try {
      const day = await window.timeCenter.getRecordings(at);
      const withWords = day.recordings.filter((recording) => recording.lines.length > 0);
      setCalls(withWords);
      setRecordingId((chosen) =>
        withWords.some((recording) => recording.id === chosen) ? chosen : (withWords.at(-1)?.id ?? null),
      );
    } catch (caught) {
      setProblem(`Couldn't load the calls: ${readableError(caught)}`);
    }
  }, [at]);

  useEffect(() => {
    void loadCalls();
    // Keeps a call that starts (or gets its first words) while the tab is open in the picker.
    const timer = setInterval(() => void loadCalls(), CALLS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadCalls]);

  const scopeEmpty = scope !== "all" && calls.length === 0;
  const canAsk = question.trim() !== "" && !asking && !scopeEmpty && (scope !== "call" || recordingId !== null);

  /** Sends the question and puts the saved answer at the top of the list. */
  const ask = async () => {
    if (!canAsk) {
      return;
    }
    setAsking(true);
    setProblem(null);
    try {
      const saved = await window.timeCenter.askAboutCalls({
        question,
        scope,
        at,
        recordingId: scope === "call" ? recordingId : null,
      });
      setHistory((past) => [saved, ...past]);
      setJustAsked((ids) => [...ids, saved.id]);
      if (saved.answer !== null) {
        setQuestion("");
      }
    } catch (caught) {
      setProblem(readableError(caught));
    } finally {
      setAsking(false);
    }
  };

  const shown = history.filter((item) => justAsked.includes(item.id) || isOnDay(item, dayStart));

  return (
    <div className="card ask">
      <h2>Ask about your calls</h2>
      <QuestionInput
        question={question}
        setQuestion={setQuestion}
        onAsk={() => void ask()}
        onFocus={() => void loadCalls()}
        onError={setProblem}
        asking={asking}
        placeholder="e.g. What did I say I'd send Dana?"
      />
      <div className="ask-controls">
        <label>
          About{" "}
          <select value={scope} onChange={(event) => setScope(event.target.value as CallQuestionScope)}>
            {(Object.keys(SCOPE_TEXT) as CallQuestionScope[]).map((value) => (
              <option key={value} value={value}>
                {SCOPE_TEXT[value]}
              </option>
            ))}
          </select>
        </label>
        {scope === "call" && calls.length > 0 && (
          <select
            className="ask-call"
            aria-label="Which call"
            value={recordingId ?? ""}
            onChange={(event) => setRecordingId(Number(event.target.value))}
          >
            {calls.map((call) => (
              <option key={call.id} value={call.id}>
                {formatClock(call.start)} {call.meetingTitle ?? "Call"}
                {call.end === null ? " (now)" : ""}
              </option>
            ))}
          </select>
        )}
        <span className="ask-spacer" />
        <button disabled={!canAsk} onClick={() => void ask()}>
          {asking ? "Asking…" : "Ask"}
        </button>
      </div>
      {scopeEmpty && <p className="muted">No transcribed calls on this day. Pick "All calls" to ask about older ones.</p>}
      {scope === "all" && <p className="muted">Searches your calls for the question's words and sends the best matches.</p>}
      {asking && <p className="muted">Sonnet is reading the transcripts…</p>}
      {problem && <p className="error">{problem}</p>}
      {history.length > 0 && shown.length === 0 && <p className="muted">No questions about this day's calls yet.</p>}
      {shown.length > 0 && (
        <ul className="ask-history">
          {shown.map((item) => (
            <QuestionItem key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Whether a saved question belongs on a day's Recordings tab: one of the calls it read started that day, or,
 * when it read none (it failed first), it was asked that day.
 * @param item The question.
 * @param dayStart Local midnight that starts the day.
 * @returns True when it does.
 */
export function isOnDay(item: CallQuestion, dayStart: number): boolean {
  if (item.sources.length === 0) {
    return startOfDay(item.askedAt) === dayStart;
  }
  return item.sources.some((source) => startOfDay(source.start) === dayStart);
}

/**
 * The question box inside one call on the Recordings tab: ask Sonnet about just that call. The questions you
 * asked about it before (here or in "Ask about your calls") are listed below, newest first.
 * @param props.recording The call.
 */
export function CallAskBox({ recording }: { recording: CallRecording }) {
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<CallQuestion[]>([]);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** Reads the questions asked about this call, here or in "Ask about your calls". */
  const loadHistory = useCallback(() => {
    void window.timeCenter
      .getCallQuestions()
      .then((all) => setHistory(all.filter((item) => isAbout(item, recording.id))))
      .catch((caught: unknown) => setProblem(`Couldn't load your past questions: ${readableError(caught)}`));
  }, [recording.id]);

  useEffect(loadHistory, [loadHistory]);

  /** Sends the question and puts the saved answer at the top of the list. */
  const ask = async () => {
    if (question.trim() === "" || asking) {
      return;
    }
    setAsking(true);
    setProblem(null);
    try {
      const saved = await window.timeCenter.askAboutCalls({ question, scope: "call", at: recording.start, recordingId: recording.id });
      setHistory((past) => [saved, ...past]);
      if (saved.answer !== null) {
        setQuestion("");
      }
    } catch (caught) {
      setProblem(readableError(caught));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="call-ask">
      <QuestionInput
        question={question}
        setQuestion={setQuestion}
        onAsk={() => void ask()}
        onFocus={loadHistory}
        onError={setProblem}
        asking={asking}
        placeholder="e.g. What did we decide about the release?"
      />
      <div className="ask-controls">
        <span className="muted">⌘↩ asks</span>
        <span className="ask-spacer" />
        <button disabled={question.trim() === "" || asking} onClick={() => void ask()}>
          {asking ? "Asking…" : "Ask"}
        </button>
      </div>
      {asking && <p className="muted">Sonnet is reading the transcript…</p>}
      {problem && <p className="error">{problem}</p>}
      {history.length > 0 && (
        <ul className="ask-history">
          {history.map((item) => (
            <QuestionItem key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Whether a saved question was about one call alone.
 * @param item The question.
 * @param recordingId The call.
 * @returns True when it was.
 */
export function isAbout(item: CallQuestion, recordingId: number): boolean {
  return item.scope === "call" && item.sources.length === 1 && item.sources[0].recordingId === recordingId;
}

/**
 * The box you type or dictate a question into; ⌘↩ (or Ctrl+↩) asks.
 * @param props.question What's typed.
 * @param props.setQuestion Changes it.
 * @param props.onAsk Asks it.
 * @param props.onFocus Called when the box gets focus.
 * @param props.onError Shows a dictation problem.
 * @param props.asking Whether a question is on its way.
 * @param props.placeholder The example shown while it's empty.
 * @param props.label What the box is for, for screen readers.
 */
export function QuestionInput({
  question,
  setQuestion,
  onAsk,
  onFocus,
  onError,
  asking,
  placeholder,
  label = "Your question",
}: {
  question: string;
  setQuestion(update: (typed: string) => string): void;
  onAsk(): void;
  onFocus?(): void;
  onError(problem: string | null): void;
  asking: boolean;
  placeholder: string;
  label?: string;
}) {
  /** ⌘↩ (or Ctrl+↩) asks. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onAsk();
    }
  };

  /** Adds dictated words to whatever is already typed. */
  const addDictation = (text: string) => {
    setQuestion((typed) => (typed.trim() === "" ? text : `${typed.trimEnd()} ${text}`));
  };

  return (
    <div className="ask-input">
      <textarea
        value={question}
        rows={2}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => {
          const typed = event.target.value;
          setQuestion(() => typed);
        }}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      />
      <DictationButton onText={addDictation} onError={onError} disabled={asking} />
    </div>
  );
}

/**
 * One past question: what you asked, which calls it covered, and the answer.
 * @param props.item The saved question.
 */
function QuestionItem({ item }: { item: CallQuestion }) {
  return (
    <li className="ask-item">
      <p className="ask-question">{item.question}</p>
      <p className="ask-meta" title={item.sources.map((source) => sourceText(source)).join("\n")}>
        {formatDay(startOfDay(item.askedAt), startOfDay(Date.now()))}, {formatClock(item.askedAt)} · {SCOPE_TEXT[item.scope]} ·{" "}
        {item.sources.length === 1 ? sourceText(item.sources[0]) : `${item.sources.length} calls`}
      </p>
      {item.note && <p className="ask-meta">{item.note}</p>}
      {item.answer !== null && <p className="ask-answer">{item.answer}</p>}
      {item.todos.length > 0 && <FoundTodos item={item} />}
      {item.error !== null && <p className="error">Couldn't get an answer: {item.error}</p>}
    </li>
  );
}

/**
 * Names a call a question covered.
 * @param source The call.
 * @returns e.g. "Northwind onboarding, Mon 2:00 PM".
 */
function sourceText(source: CallQuestion["sources"][number]): string {
  const day = new Date(source.start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `${source.title ?? "Call"}, ${day} ${formatClock(source.start)}`;
}

/**
 * The TODOs Sonnet found while answering, each with an Add to TODOs button that links it to the call it came from.
 * @param props.item The saved question.
 */
function FoundTodos({ item }: { item: CallQuestion }) {
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Adds a found TODO to the list, in Work.
   * @param todo The TODO.
   * @param index Its place in the list.
   */
  const addToTodos = async (todo: CallQuestionTodo, index: number) => {
    // Marked straight away, so a double-click adds it once.
    setAdded((current) => new Set(current).add(index));
    const source = item.sources.find((each) => each.recordingId === todo.recordingId);
    try {
      await window.timeCenter.addTodo({
        markdown: escapeMarkdown(todo.text),
        section: "work",
        source: { recordingId: todo.recordingId, title: source?.title ?? "Call", saidAt: todo.saidAt },
      });
      setProblem(null);
    } catch (error) {
      setAdded((current) => {
        const next = new Set(current);
        next.delete(index);
        return next;
      });
      setProblem(readableError(error));
    }
  };

  return (
    <>
      <ul className="action-items ask-todos">
        {item.todos.map((todo, index) => (
          <li key={index}>
            <span className="action-text">{todo.text}</span>
            <span className="action-time">
              {item.sources.length > 1 && `${item.sources.find((each) => each.recordingId === todo.recordingId)?.title ?? "Call"}, `}
              {formatClock(todo.saidAt)}
            </span>
            <button type="button" className="secondary action-add" disabled={added.has(index)} onClick={() => void addToTodos(todo, index)}>
              {added.has(index) ? "Added ✓" : "Add to TODOs"}
            </button>
          </li>
        ))}
      </ul>
      {problem && <p className="error">{problem}</p>}
    </>
  );
}
