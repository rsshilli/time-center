import { useCallback, useEffect, useRef, useState } from "react";
import type { CallRecording, RecordingsReport } from "../shared/ipc";
import { CallAskBox } from "./AskCard";
import { readableError } from "./CalendarSettings";
import { ActionItemList } from "./LiveCallCard";
import { formatClock, groupTurns, transcriptText } from "../shared/transcript";
import { SPEAKERS_CHANGED, TranscriptTurns } from "./TranscriptTurns";

/** How often the day's calls are re-read while a call is recording or being transcribed. */
const BUSY_REFRESH_MS = 5_000;

/** How often they're re-read otherwise, to notice a new call. */
const IDLE_REFRESH_MS = 30_000;

/**
 * Reads the picked day's calls, often while one is recording or being transcribed and now and then otherwise.
 * @param at A moment in the day.
 * @returns The report (null until it first loads, and again when the day changes) and any error.
 */
export function useRecordings(at: number): { report: RecordingsReport | null; error: string | null } {
  const [report, setReport] = useState<RecordingsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Counts requests, so a slow answer for a day you already left can't replace a newer one. */
  const latestRequest = useRef(0);

  useEffect(() => {
    // A newly picked day starts blank rather than showing the calls of the day you left.
    setReport(null);
  }, [at]);

  /** Reads the day's calls. */
  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    try {
      const day = await window.timeCenter.getRecordings(at);
      if (request === latestRequest.current) {
        setReport(day);
        setError(null);
      }
    } catch (caught) {
      if (request === latestRequest.current) {
        setError(readableError(caught));
      }
    }
  }, [at]);

  const busy = report?.recordings.some((recording) => recording.end === null || recording.waitingChunks > 0) ?? false;

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), busy ? BUSY_REFRESH_MS : IDLE_REFRESH_MS);
    /** Re-reads at once after a speaker is named, so every call they're in shows the name. */
    const reload = () => void load();
    window.addEventListener(SPEAKERS_CHANGED, reload);
    return () => {
      clearInterval(timer);
      window.removeEventListener(SPEAKERS_CHANGED, reload);
    };
  }, [load, busy]);

  return { report, error };
}

/**
 * The day's recorded calls, each with its action items, its transcript (you and them, turn by turn), its
 * state while it is still being transcribed, and its audio in Finder for the 30 days it's kept.
 * @param props.recordings The calls to list (the live one is shown above instead).
 * @param props.transcriberProblem Anything stopping transcription.
 * @param props.earlier Whether a live call is shown above, so these are the earlier ones.
 */
export function RecordingsCard({
  recordings,
  transcriberProblem,
  earlier,
}: {
  recordings: CallRecording[];
  transcriberProblem: string | null;
  earlier: boolean;
}) {
  return (
    <div className="card recordings">
      <h2>{earlier ? "Earlier calls" : "Calls"}</h2>
      {transcriberProblem && <p className="message">{transcriberProblem}</p>}
      {recordings.length === 0 && <p className="muted">{earlier ? "No earlier calls on this day." : "No calls recorded on this day."}</p>}
      <ul className="recording-list">
        {recordings.map((recording) => (
          <RecordingItem key={recording.id} recording={recording} />
        ))}
      </ul>
    </div>
  );
}

/**
 * One call: when, what meeting and its state, folded. The chevron opens its possible TODOs, its transcript and a
 * box to ask about it.
 * @param props.recording The call.
 */
function RecordingItem({ recording }: { recording: CallRecording }) {
  const [open, setOpen] = useState(false);
  const bodyId = `call-${recording.id}`;
  const [message, setMessage] = useState<string | null>(null);
  const turns = groupTurns(recording.lines, recording.speakers);

  /** Puts the transcript on the clipboard as plain text. */
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(transcriptText(recording.lines, recording.speakers, recording.meetings));
      setMessage("Transcript copied");
    } catch (caught) {
      setMessage(`Couldn't copy it: ${readableError(caught)}`);
    }
  };

  /** Shows the call's audio file in Finder (its working folder while it's still being mixed). */
  const showAudio = async () => {
    try {
      await window.timeCenter.showRecordingAudio(recording.id);
    } catch (caught) {
      setMessage(readableError(caught));
    }
  };

  return (
    <li className={open ? "recording open" : "recording"}>
      <div className="recording-head">
        <button
          type="button"
          className="chevron"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={open ? "Fold this call" : "Open this call's TODOs, transcript and questions"}
          onClick={() => setOpen(!open)}
        >
          ›
        </button>
        <span className="meeting-time">
          {formatClock(recording.start)}
          {recording.end !== null && ` – ${formatClock(recording.end)}`}
        </span>
        <button
          type="button"
          className="recording-title"
          tabIndex={-1}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          {recording.meetingTitle ?? "Call"}
        </button>
        <span className="muted">{stateText(recording) || todoCount(recording)}</span>
        <span className="recording-actions">
          {turns.length > 0 && (
            <button className="link" onClick={() => void copy()}>
              Copy
            </button>
          )}
          {recording.audioKept && (
            <button className="link" onClick={() => void showAudio()}>
              Audio
            </button>
          )}
        </span>
      </div>
      {!recording.mic && <p className="muted">macOS didn't allow the microphone, so only the other side was recorded.</p>}
      {recording.error && <p className="muted">{recording.error}</p>}
      {recording.unreadChunks > 0 && turns.length > 0 && (
        <p className="muted">Part of this call couldn't be transcribed; it's still in the audio.</p>
      )}
      {message && <p className="message">{message}</p>}
      {open && (
        <div className="recording-body" id={bodyId}>
          <section className="recording-actions-found">
            <h3>Possible TODOs</h3>
            {recording.actionItems.length > 0 ? (
              <ActionItemList items={recording.actionItems} recording={recording} />
            ) : (
              <p className="muted">None found in this call.</p>
            )}
          </section>
          <section>
            <h3>Transcript</h3>
            {recording.lines.length > 0 ? <TranscriptTurns recording={recording} /> : <p className="muted">{stateText(recording) || "Nothing said."}</p>}
          </section>
          {turns.length > 0 && (
            <section>
              <h3>Ask about this call</h3>
              {recording.end === null || recording.waitingChunks > 0 ? (
                <p className="muted">You can ask once the whole call is transcribed.</p>
              ) : (
                <CallAskBox recording={recording} />
              )}
            </section>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * How many possible TODOs a call has, for its folded row.
 * @param recording The call.
 * @returns e.g. "2 possible TODOs", or "" when there are none.
 */
export function todoCount(recording: CallRecording): string {
  const count = recording.actionItems.length;
  if (count === 0) {
    return "";
  }
  return `${count} possible ${count === 1 ? "TODO" : "TODOs"}`;
}

/**
 * Says where a call is up to, in a few words.
 * @param recording The call.
 * @returns e.g. "Recording now", "Transcribing (3 pieces left)", "Nothing said", or "".
 */
export function stateText(recording: CallRecording): string {
  if (recording.end === null) {
    return "● Recording now";
  }
  if (recording.waitingChunks > 0) {
    return `Transcribing (${recording.waitingChunks} ${recording.waitingChunks === 1 ? "piece" : "pieces"} left)`;
  }
  if (recording.lines.length > 0) {
    return "";
  }
  return recording.unreadChunks > 0 ? "Couldn't be transcribed" : "Nothing said";
}
