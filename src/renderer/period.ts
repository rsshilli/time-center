import { startOfDay } from "./day";

/** How much of your time the My time tab shows: one day, a Monday-to-Sunday week, the last 7 days, or a month. */
export type Period = "day" | "week" | "last7" | "month";

/** Each period's button, in the order the toggle shows them. */
export const PERIOD_LABELS: Record<Period, string> = { day: "Day", week: "Week", last7: "Last 7 days", month: "Month" };

/**
 * Finds the days a period covers around a moment, stopping at the end of today, so this week and this month
 * come out "so far".
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
 * Moves a period back or forward by its own length: a week, 7 days, or a month. A day moves by a day.
 * @param period The period.
 * @param at A moment in the picked day.
 * @param direction -1 for earlier, 1 for later.
 * @param now The current time.
 * @returns A moment in the period moved to, never after today.
 */
export function shiftPeriod(period: Period, at: number, direction: -1 | 1, now: number): number {
  let moved: number;
  if (period === "month") {
    const date = new Date(fullRange("month", at).from);
    date.setMonth(date.getMonth() + direction);
    moved = date.getTime();
  } else {
    moved = addDays(startOfDay(at), (period === "day" ? 1 : 7) * direction);
  }
  return Math.min(moved, startOfDay(now));
}

/**
 * Says whether the period after this one has started yet, for the forward arrow.
 * @param period The period.
 * @param at A moment in the picked day.
 * @param now The current time.
 * @returns True when there's a later period to move to.
 */
export function canGoLater(period: Period, at: number, now: number): boolean {
  if (period === "last7" || period === "day") {
    return startOfDay(at) < startOfDay(now);
  }
  return fullRange(period, at).to <= startOfDay(now);
}

/**
 * Names the period shown, in plain words.
 * @param period A period longer than a day.
 * @param at A moment in the picked day.
 * @param now The current time.
 * @returns e.g. "This week so far", "Last week", "Week of Monday, November 2", "Last 7 days", "November so far".
 */
export function periodTitle(period: Exclude<Period, "day">, at: number, now: number): string {
  const today = startOfDay(now);
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
  if (period === "last7") {
    if (startOfDay(at) === today) {
      return "Last 7 days";
    }
    return `7 days to ${new Date(startOfDay(at)).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`;
  }
  const month = new Date(from).toLocaleDateString(undefined, { month: "long" });
  if (from === fullRange("month", now).from) {
    return `${month} so far`;
  }
  return new Date(from).toLocaleDateString(undefined, { month: "long", year: "numeric" });
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
  if (period === "last7") {
    return { from: addDays(day, -6), to: addDays(day, 1) };
  }
  if (period === "month") {
    const first = new Date(day);
    first.setDate(1);
    const next = new Date(first);
    next.setMonth(next.getMonth() + 1);
    return { from: first.getTime(), to: next.getTime() };
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
