import { AskCard } from "./AskCard";
import { DayHeader } from "./DayHeader";
import { LiveCallCard, liveCall } from "./LiveCallCard";
import { RecordingsCard, useRecordings } from "./RecordingsCard";

/**
 * The Recordings tab: the call going on now (its transcript and possible action items), a box to ask Sonnet
 * about your calls, then the picked day's other calls, each with its transcript and audio.
 * @param props.at A moment in the picked day, shared with the Today tab.
 * @param props.onChangeDay Called with a moment in the newly picked day.
 */
export function RecordingsScreen({ at, onChangeDay }: { at: number; onChangeDay: (at: number) => void }) {
  const { report, error } = useRecordings(at);
  const live = report ? liveCall(report.recordings, Date.now()) : null;
  return (
    <section className="recordings-screen">
      <DayHeader at={at} onChange={onChangeDay} />
      {live && <LiveCallCard key={live.id} recording={live} />}
      <AskCard at={at} />
      {error && <p className="error">Couldn't load the calls: {error}</p>}
      {report && (
        <RecordingsCard
          recordings={report.recordings.filter((recording) => recording.id !== live?.id)}
          transcriberProblem={report.transcriberProblem}
          earlier={live !== null}
        />
      )}
    </section>
  );
}
