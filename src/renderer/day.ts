/**
 * Finds the local midnight a moment's day starts at.
 * @param ms The moment.
 * @returns That day's local midnight.
 */
export function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Moves to the day before or after, by calendar date rather than 24 hours, so a clock change can't skip
 * or repeat a day.
 * @param ms A moment in the current day.
 * @param direction -1 for the day before, 1 for the day after.
 * @returns The other day's local midnight.
 */
export function shiftDay(ms: number, direction: -1 | 1): number {
  const date = new Date(startOfDay(ms));
  date.setDate(date.getDate() + direction);
  return date.getTime();
}
