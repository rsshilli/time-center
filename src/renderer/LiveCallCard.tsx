import { useEffect, useRef, useState } from "react";
import { CALL_FINISHING_MS, type ActionItemsReport, type CallRecording } from "../shared/ipc";
import { readableError } from "./CalendarSettings";
import { formatClock, groupTurns } from "../shared/transcript";
import { escapeMarkdown } from "./todoOrder";
import { TranscriptTurns } from "./TranscriptTurns";
import { CatchUpBar } from "./CatchUpBar";
import { DismissButton } from "./DismissButton";
import { useDismissals } from "./useDismissals";

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
  const transcript = useRef<HTMLOListElement>(null);
  /** Whether you're at the bottom of the transcript, so new words scroll into view; false once you scroll up. */
  const following = useRef(true);

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

  return (
    <div className="card live-call">
      <div className="live-head">
        <h2>
          {/* The meeting you're in now, when the call has run through several. */}
          <span className="live-dot">●</span> {recording.meetings.at(-1)?.title ?? recording.meetingTitle ?? "Call"}
        </h2>
        <span className="muted">
          {recording.end === null ? `Since ${formatClock(recording.start)}` : "Ended; finishing the transcript"}
        </span>
      </div>
      <CatchUpBar recordingId={recording.id} />
      <div className="live-columns">
        <div className="live-transcript">
          <h3>Transcript</h3>
          {/* Lines rather than turns: hiding the only line keeps the transcript, and so its Undo, in place. */}
          {recording.lines.length === 0 ? (
            <p className="muted">Words show up here a few seconds after they're said.</p>
          ) : (
            <TranscriptTurns recording={recording} listRef={transcript} onScroll={onScroll} />
          )}
        </div>
        <div className="live-actions">
          <h3>Possible action items</h3>
          <ScannedActionItems
            recording={recording}
            limit={ITEMS_SHOWN}
            empty={turns.length === 0 ? "Waiting for the call's first words." : "None found yet."}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * A call's action items with a Scan for TODOs button: Sonnet reads the call when you press it, and nothing runs
 * otherwise. A scan keeps what was found before and adds to it.
 * @param props.recording The call, live or past.
 * @param props.empty What to say when a scan found none.
 * @param props.limit The most shown.
 */
export function ScannedActionItems({ recording, empty, limit }: { recording: CallRecording; empty: string; limit?: number }) {
  const [scanned, setScanned] = useState<ActionItemsReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The day reloads every few seconds; whichever list is newer, this scan's answer or the saved one, is shown.
  const fresher = scanned !== null && scanned.checkedAt >= (recording.actionItemsScannedAt ?? 0);
  const items = fresher ? scanned.items : recording.actionItems;
  const scannedAt = fresher ? scanned.checkedAt : recording.actionItemsScannedAt;

  /** Asks Sonnet to read the call now. */
  const scan = async () => {
    setScanning(true);
    try {
      setScanned(await window.timeCenter.scanActionItems(recording.id));
      setProblem(null);
    } catch (caught) {
      setProblem(readableError(caught));
    } finally {
      setScanning(false);
    }
  };

  return (
    <>
      {/* Always there, even when empty, so Undo stays after the last item is dismissed and the list reloads. */}
      <ActionItemList items={items} limit={limit} recording={recording} empty={scannedAt === null ? "Not scanned yet." : empty} />
      <p className="scan-row">
        <button type="button" className="secondary" disabled={scanning || recording.lines.length === 0} onClick={() => void scan()}>
          {scanning ? "Scanning…" : "Scan for TODOs"}
        </button>{" "}
        <span className="muted">
          {scannedAt === null ? "Claude Sonnet reads the call when you press it." : `Last scanned ${formatClock(scannedAt)}.`}
        </span>
      </p>
      {problem && <p className="message">Couldn't scan: {problem}</p>}
    </>
  );
}

/**
 * A list of action items, each with when it was said, a button that copies it to the TODO list, and one that
 * dismisses it (with Undo) so it isn't suggested again.
 * @param props.items The items, newest first.
 * @param props.recording The call they came from, which the TODO links back to.
 * @param props.empty What to say when there are none.
 * @param props.limit The most shown, counted after the dismissed ones are taken out.
 */
export function ActionItemList({
  items,
  recording,
  empty,
  limit,
}: {
  items: CallRecording["actionItems"];
  recording: CallRecording;
  empty: string;
  limit?: number;
}) {
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const dismissals = useDismissals(items, (item) => ({ recordingId: recording.id, saidAt: item.saidAt, text: item.text }));

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
      {dismissals.shown.length === 0 && <p className="muted">{dismissals.anyDismissed ? "All dismissed." : empty}</p>}
      <ul className="action-items">
        {dismissals.shown.slice(0, limit).map((item) => {
          const key = `${item.saidAt}:${item.text}`;
          return (
            <li key={key}>
              <span className="action-text">{item.text}</span>
              <span className="action-time">{formatClock(item.saidAt)}</span>
              <button type="button" className="secondary action-add" disabled={added.has(key)} onClick={() => void addToTodos(item, key)}>
                {added.has(key) ? "Added ✓" : "Add to TODOs"}
              </button>
              <DismissButton onClick={() => dismissals.dismiss(item)} />
            </li>
          );
        })}
      </ul>
      {dismissals.note}
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
    recording.waitingChunks > 0 &&
    now - recording.end < CALL_FINISHING_MS;
  return recordings.findLast((recording) => recording.end === null || finishing(recording)) ?? null;
}
