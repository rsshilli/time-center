import { startOfDay } from "./day";

/** How much of your time the My time tab shows: one day, a Monday-to-Sunday week, or 4 weeks up to a day. */
export type Period = "day" | "week" | "fourWeeks";

/** The buttons at the top of the My time tab, each a shortcut to a period. */
export type Preset = "day" | "thisWeek" | "lastWeek" | "last4Weeks";

/** Each button's label, in the order they're shown. */
export const PRESET_LABELS: Record<Preset, string> = {
  day: "Day",
  thisWeek: "This week so far",
  lastWeek: "Last week",
  last4Weeks: "Last 4 weeks",
};

/** How many days "4 weeks" covers: the picked day and the 27 before it. */
const FOUR_WEEKS_DAYS = 28;

/**
 * Where a button takes you. Day keeps the day you're on; the others jump to their stretch.
 * @param preset The button.
 * @param at A moment in the picked day.
 * @param now The current time.
 * @returns The period and a moment in it.
 */
export function presetView(preset: Preset, at: number, now: number): { period: Period; at: number } {
  if (preset === "day") {
    return { period: "day", at };
  }
  if (preset === "thisWeek") {
    return { period: "week", at: startOfDay(now) };
  }
  if (preset === "lastWeek") {
    return { period: "week", at: addDays(fullRange("week", now).from, -7) };
  }
  return { period: "fourWeeks", at: startOfDay(now) };
}

/**
 * Which button matches what's showing, so it can be lit.
 * @param period The period showing.
 * @param at A moment in the picked day.
 * @param now The current time.
 * @returns The button, or null when the arrows have moved somewhere none of them names.
 */
export function activePreset(period: Period, at: number, now: number): Preset | null {
  const shown = fullRange(period, at).from;
  for (const preset of Object.keys(PRESET_LABELS) as Preset[]) {
    const view = presetView(preset, at, now);
    if (view.period === period && fullRange(period, view.at).from === shown) {
      return preset;
    }
  }
  return null;
}

/**
 * Finds the days a period covers around a moment, stopping at the end of today, so this week comes out
 * "so far".
 * @param period The period.
 * @param at A moment in the picked day.
 * @param now The current time.
 * @returns Local midnight starting the first day, and local midnight after the last one.
 */
export function periodRange(period: Period, at: number, now: number): { from: number; to: number } {
  const { from, to } = fullRange(period, at);
  return { from, to: Math.min(to, addDays(startOfDay(now), 1)) };
}

/**
 * Moves a period back or forward by its own length: a day, a week or 4 weeks.
 * @param period The period.
 * @param at A moment in the picked day.
 * @param direction -1 for earlier, 1 for later.
 * @param now The current time.
 * @returns A moment in the period moved to, never after today.
 */
export function shiftPeriod(period: Period, at: number, direction: -1 | 1, now: number): number {
  const days = period === "day" ? 1 : period === "week" ? 7 : FOUR_WEEKS_DAYS;
  return Math.min(addDays(startOfDay(at), days * direction), startOfDay(now));
}

/**
 * Says whether there's a later period to move to, for the forward arrow.
 * @param period The period.
 * @param at A moment in the picked day.
 * @param now The current time.
 * @returns True when there's a later period to move to.
 */
export function canGoLater(period: Period, at: number, now: number): boolean {
  if (period === "week") {
    return fullRange(period, at).to <= startOfDay(now);
  }
  return startOfDay(at) < startOfDay(now);
}

/**
 * Names the period shown, in plain words.
 * @param period A period longer than a day.
 * @param at A moment in the picked day.
 * @param now The current time.
 * @returns e.g. "This week so far", "Last week", "Week of Monday, November 2", "Last 4 weeks", "4 weeks to …".
 */
export function periodTitle(period: Exclude<Period, "day">, at: number, now: number): string {
  const { from } = fullRange(period, at);
  if (period === "week") {
    const thisWeek = fullRange("week", now).from;
    if (from === thisWeek) {
      return "This week so far";
    }
    if (from === addDays(thisWeek, -7)) {
      return "Last week";
    }
    return `Week of ${new Date(from).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`;
  }
  if (startOfDay(at) === startOfDay(now)) {
    return "Last 4 weeks";
  }
  return `4 weeks to ${new Date(startOfDay(at)).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`;
}

/**
 * Finds every day of a period around a moment, today or not.
 * @param period The period.
 * @param at A moment in the picked day.
 * @returns Local midnight starting the first day, and local midnight after the last one.
 */
function fullRange(period: Period, at: number): { from: number; to: number } {
  const day = startOfDay(at);
  if (period === "week") {
    // getDay() is 0 on Sunday; weeks start on Monday.
    const from = addDays(day, -((new Date(day).getDay() + 6) % 7));
    return { from, to: addDays(from, 7) };
  }
  if (period === "fourWeeks") {
    return { from: addDays(day, 1 - FOUR_WEEKS_DAYS), to: addDays(day, 1) };
  }
  return { from: day, to: addDays(day, 1) };
}

/**
 * Moves by whole calendar days, so a clock change can't skip or repeat one.
 * @param dayStart A local midnight.
 * @param days How many days, negative for earlier.
 * @returns That day's local midnight.
 */
function addDays(dayStart: number, days: number): number {
  const date = new Date(dayStart);
  date.setDate(date.getDate() + days);
  return date.getTime();
}
