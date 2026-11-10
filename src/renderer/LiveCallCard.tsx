import { useEffect, useRef, useState } from "react";
import { CALL_FINISHING_MS, type ActionItemsReport, type CallRecording } from "../shared/ipc";
import { readableError } from "./CalendarSettings";
import { formatClock, groupTurns } from "../shared/transcript";
import { escapeMarkdown } from "./todoOrder";
import { TranscriptTurns } from "./TranscriptTurns";

/** How often the card asks for fresh action items; the main process calls Haiku at most once a minute. */
const ACTION_POLL_MS = 15_000;

/** Action items shown, newest first. */
export const ITEMS_SHOWN = 5;

/** How close to the bottom (in pixels) the transcript must be scrolled to keep following new words. */
const FOLLOW_SLACK_PX = 40;

/**
 * The call going on now: its transcript as it's heard, on the left, and the newest potential action items
 * Haiku found in it, on the right. Haiku is only asked while this card is on screen and the window is visible.
 * @param props.recording The live call (or one whose last words are still being transcribed).
 */
export function LiveCallCard({ recording }: { recording: CallRecording }) {
  const turns = groupTurns(recording.lines, recording.speakers);
  const [items, setItems] = useState<ActionItemsReport>({ items: recording.actionItems, checkedAt: null, problem: null });
  const [failure, setFailure] = useState<string | null>(null);
  const transcript = useRef<HTMLOListElement>(null);
  /** Whether you're at the bottom of the transcript, so new words scroll into view; false once you scroll up. */
  const following = useRef(true);

  useEffect(() => {
    let current = true;
    /** Asks for the call's action items, unless the window is hidden. */
    const refresh = async () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      try {
        const report = await window.timeCenter.refreshActionItems(recording.id);
        if (current) {
          setItems(report);
          setFailure(null);
        }
      } catch (caught) {
        if (current) {
          setFailure(readableError(caught));
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), ACTION_POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [recording.id]);

  useEffect(() => {
    const list = transcript.current;
    if (list && following.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [turns.length, recording.lines.length]);

  /** Notes whether you've scrolled away from the newest words. */
  const onScroll = () => {
    const list = transcript.current;
    if (list) {
      following.current = list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_SLACK_PX;
    }
  };

  const problem = failure ?? items.problem;
  return (
    <div className="card live-call">
      <div className="live-head">
        <h2>
          <span className="live-dot">●</span> {recording.meetingTitle ?? "Call"}
        </h2>
        <span className="muted">
          {recording.end === null ? `Since ${formatClock(recording.start)}` : "Ended; finishing the transcript"}
        </span>
      </div>
      <div className="live-columns">
        <div className="live-transcript">
          <h3>Transcript</h3>
          {turns.length === 0 ? (
            <p className="muted">Words show up here a few seconds after they're said.</p>
          ) : (
            <TranscriptTurns recording={recording} listRef={transcript} onScroll={onScroll} />
          )}
        </div>
        <div className="live-actions">
          <h3>Possible action items</h3>
          {items.items.length === 0 ? (
            <p className="muted">{turns.length === 0 ? "Waiting for the call's first words." : "None yet."}</p>
          ) : (
            <ActionItemList items={items.items.slice(0, ITEMS_SHOWN)} recording={recording} />
          )}
          {problem ? (
            <p className="message">Couldn't check for action items: {problem}</p>
          ) : (
            <p className="muted live-note">
              Claude Haiku looks again each minute there's something new, while this tab is open
              {items.checkedAt !== null && ` · last looked at ${formatClock(items.checkedAt)}`}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A list of action items, each with when it was said and a button that copies it to the TODO list.
 * @param props.items The items, newest first.
 * @param props.recording The call they came from, which the TODO links back to.
 */
export function ActionItemList({ items, recording }: { items: CallRecording["actionItems"]; recording: CallRecording }) {
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Adds an item to the TODO list, linked to this call.
   * @param item The action item.
   * @param key Its key in the list.
   */
  const addToTodos = async (item: CallRecording["actionItems"][number], key: string) => {
    // Marked straight away, so a double-click adds it once.
    setAdded((current) => new Set(current).add(key));
    try {
      await window.timeCenter.addTodo({
        markdown: escapeMarkdown(item.text),
        section: "work",
        source: { recordingId: recording.id, title: recording.meetingTitle ?? "Call", saidAt: item.saidAt },
      });
      setProblem(null);
    } catch (error) {
      setAdded((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      setProblem(readableError(error));
    }
  };

  return (
    <>
      <ul className="action-items">
        {items.map((item) => {
          const key = `${item.saidAt}:${item.text}`;
          return (
            <li key={key}>
              <span className="action-text">{item.text}</span>
              <span className="action-time">{formatClock(item.saidAt)}</span>
              <button type="button" className="secondary action-add" disabled={added.has(key)} onClick={() => void addToTodos(item, key)}>
                {added.has(key) ? "Added ✓" : "Add to TODOs"}
              </button>
            </li>
          );
        })}
      </ul>
      {problem && <p className="error">{problem}</p>}
    </>
  );
}

/**
 * Picks the call to show live: one still recording, or one that ended in the last few minutes whose last
 * words are still being transcribed or not yet read by Haiku (so its final action items come in while you
 * watch).
 * @param recordings The day's calls, oldest first.
 * @param now The time.
 * @returns The newest such call, or null.
 */
export function liveCall(recordings: CallRecording[], now: number): CallRecording | null {
  /**
   * @param recording A call.
   * @returns Whether it ended recently and still has words to transcribe or for Haiku to read.
   */
  const finishing = (recording: CallRecording) =>
    recording.end !== null &&
    (recording.waitingChunks > 0 || recording.actionItemsBehind) &&
    now - recording.end < CALL_FINISHING_MS;
  return recordings.findLast((recording) => recording.end === null || finishing(recording)) ?? null;
}
