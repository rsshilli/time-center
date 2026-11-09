import { AskCard } from "./AskCard";
import { DayHeader } from "./DayHeader";
import { RecordingsCard } from "./RecordingsCard";

/**
 * The Recordings tab: a box to ask Sonnet about your calls, then the picked day's calls, each with its
 * transcript and audio.
 * @param props.at A moment in the picked day, shared with the Today tab.
 * @param props.onChangeDay Called with a moment in the newly picked day.
 */
export function RecordingsScreen({ at, onChangeDay }: { at: number; onChangeDay: (at: number) => void }) {
  return (
    <section className="recordings-screen">
      <DayHeader at={at} onChange={onChangeDay} />
      <AskCard at={at} />
      <RecordingsCard at={at} />
    </section>
  );
}
