import { startOfDay, shiftDay } from "./day";
import { formatDay } from "./format";

/**
 * The day picker at the top of the Today and Recordings tabs: the day's name, arrows for the day before and
 * after, and a Today button once you've left today. Both tabs share the picked day.
 * @param props.at A moment in the picked day.
 * @param props.onChange Called with a moment in the newly picked day.
 */
export function DayHeader({ at, onChange }: { at: number; onChange: (at: number) => void }) {
  const today = startOfDay(Date.now());
  const dayStart = startOfDay(at);
  const isToday = dayStart === today;
  return (
    <header className="day-header">
      <button className="secondary" onClick={() => onChange(shiftDay(at, -1))} aria-label="Day before">
        ‹
      </button>
      <h1>{formatDay(dayStart, today)}</h1>
      <button className="secondary" onClick={() => onChange(shiftDay(at, 1))} disabled={isToday} aria-label="Day after">
        ›
      </button>
      {!isToday && (
        <button className="secondary" onClick={() => onChange(Date.now())}>
          Today
        </button>
      )}
    </header>
  );
}
