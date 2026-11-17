import { useState } from "react";
import { CATCH_UP_MINUTES, type CatchUp, type CatchUpMinutes } from "../shared/ipc";
import { formatClock } from "../shared/transcript";
import { readableError } from "./CalendarSettings";

/**
 * "Haven't been paying attention?" on the live call: pick 2, 5 or 10 minutes and Claude Haiku sums up what was
 * said in that time, starting with anything you were asked.
 * @param props.recordingId The live call.
 */
export function CatchUpBar({ recordingId }: { recordingId: number }) {
  const [asking, setAsking] = useState<CatchUpMinutes | null>(null);
  const [result, setResult] = useState<CatchUp | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Asks for a summary of the last few minutes.
   * @param minutes How far back.
   */
  const ask = async (minutes: CatchUpMinutes) => {
    setAsking(minutes);
    setProblem(null);
    try {
      setResult(await window.timeCenter.catchUpOnCall(recordingId, minutes));
    } catch (error) {
      setProblem(`Couldn't catch you up: ${readableError(error)}`);
    } finally {
      setAsking(null);
    }
  };

  return (
    <div className="catch-up">
      <div className="catch-up-bar" role="group" aria-label="Catch me up">
        <span className="muted">Haven't been paying attention? Catch me up on the last</span>
        {CATCH_UP_MINUTES.map((minutes) => (
          <button key={minutes} type="button" className="secondary" disabled={asking !== null} onClick={() => void ask(minutes)}>
            {asking === minutes ? "Reading…" : `${minutes} min`}
          </button>
        ))}
      </div>
      {problem && <p className="error">{problem}</p>}
      {result && (
        <div className="catch-up-summary" role="status">
          <div className="catch-up-head">
            <strong>
              Last {result.minutes} minutes · {formatClock(result.from)} – {formatClock(result.to)}
            </strong>
            <button type="button" className="link" aria-label="Close the summary" onClick={() => setResult(null)}>
              ✕
            </button>
          </div>
          <p className="catch-up-text">{result.summary}</p>
        </div>
      )}
    </div>
  );
}
