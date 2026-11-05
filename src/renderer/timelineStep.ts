/** One minute, in milliseconds: how far one arrow-key press moves along the timeline. */
export const MINUTE = 60_000;

/** How far Shift + arrow moves along the timeline. */
export const SHIFT_STEP = 10 * MINUTE;

/**
 * Works out the moment an arrow-key press moves to. A moment between minute marks (from a click) first
 * lands on the mark in that direction, so presses always walk whole minutes. Never leaves the shown range.
 * @param current The picked moment.
 * @param direction -1 for earlier (Left), 1 for later (Right).
 * @param step How far to move: `MINUTE`, or `SHIFT_STEP` with Shift held.
 * @param from The first moment the timeline shows.
 * @param to The last moment the timeline shows.
 * @returns The new moment.
 */
export function stepMoment(current: number, direction: -1 | 1, step: number, from: number, to: number): number {
  const snapped = direction === 1 ? Math.floor(current / MINUTE) * MINUTE : Math.ceil(current / MINUTE) * MINUTE;
  return Math.min(to, Math.max(from, snapped + direction * step));
}
