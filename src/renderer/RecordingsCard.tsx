import { useCallback, useEffect, useRef, useState } from "react";
import type { CallRecording, RecordingsReport } from "../shared/ipc";
import { readableError } from "./CalendarSettings";
import { SIDE_NAMES, formatClock, groupTurns, transcriptText } from "../shared/transcript";

/** How often the card re-reads while a call is recording or being transcribed. */
const BUSY_REFRESH_MS = 5_000;

/** How often it re-reads otherwise, to notice a new call. */
const IDLE_REFRESH_MS = 30_000;

/**
 * The day's recorded calls, each with its transcript (you and them, turn by turn), its state while it is
 * still recording or being transcribed, and its audio in Finder for the 30 days it's kept.
 * @param props.at A moment in the day to show.
 */
export function RecordingsCard({ at }: { at: number }) {
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
    return () => clearInterval(timer);
  }, [load, busy]);

  if (error) {
    return <p className="error">Couldn't load the calls: {error}</p>;
  }
  if (!report) {
    return null;
  }
  return (
    <div className="card recordings">
      <h2>Calls</h2>
      {report.transcriberProblem && <p className="message">{report.transcriberProblem}</p>}
      {report.recordings.length === 0 && <p className="muted">No calls recorded on this day.</p>}
      <ul className="recording-list">
        {report.recordings.map((recording) => (
          <RecordingItem key={recording.id} recording={recording} />
        ))}
      </ul>
    </div>
  );
}

/**
 * One call: when, what meeting, its state, and its transcript when opened.
 * @param props.recording The call.
 */
function RecordingItem({ recording }: { recording: CallRecording }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const turns = groupTurns(recording.lines);

  /** Puts the transcript on the clipboard as plain text. */
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(transcriptText(recording.lines));
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
    <li className="recording">
      <div className="recording-head">
        <span className="meeting-time">
          {formatClock(recording.start)}
          {recording.end !== null && ` – ${formatClock(recording.end)}`}
        </span>
        <span className="recording-title">{recording.meetingTitle ?? "Call"}</span>
        <span className="muted">{stateText(recording)}</span>
        <span className="recording-actions">
          {turns.length > 0 && (
            <button className="link" onClick={() => setOpen(!open)}>
              {open ? "Hide transcript" : "Transcript"}
            </button>
          )}
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
        <ol className="transcript">
          {turns.map((turn) => (
            <li key={`${turn.side}@${turn.start}`} className={`turn turn-${turn.side}`}>
              <span className="turn-time">{formatClock(turn.start)}</span>
              <span className="turn-side">{SIDE_NAMES[turn.side]}</span>
              <span className="turn-text">{turn.text}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
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
