import type { TimelineItem } from "../shared/ipc";

/** One minute, in milliseconds: how far Ctrl + arrow moves along the timeline. */
export const MINUTE = 60_000;

/** How far Shift + arrow moves along the timeline. */
export const SHIFT_STEP = 10 * MINUTE;

/**
 * Works out the moment an arrow-key press moves to: the next or previous time the app in front changed,
 * or you went idle, came back, or switched to an ignored app. From the middle of a stretch, Left goes to
 * where that stretch started. Stays put when there is no change further in that direction.
 * @param timeline The day's stretches, in time order.
 * @param current The picked moment.
 * @param direction -1 for earlier (Left), 1 for later (Right).
 * @returns The new moment.
 */
export function stepToChange(timeline: TimelineItem[], current: number, direction: -1 | 1): number {
  const changes = changeMoments(timeline);
  if (direction === 1) {
    return changes.find((moment) => moment > current) ?? current;
  }
  return changes.findLast((moment) => moment < current) ?? current;
}

/**
 * Works out the moment a Shift or Ctrl arrow-key press moves to. A moment between minute marks (from a
 * click) first lands on the mark in that direction, so presses always walk whole minutes. Never leaves the
 * shown range.
 * @param current The picked moment.
 * @param direction -1 for earlier (Left), 1 for later (Right).
 * @param step How far to move: `MINUTE` with Ctrl, `SHIFT_STEP` with Shift.
 * @param from The first moment the timeline shows.
 * @param to The last moment the timeline shows.
 * @returns The new moment.
 */
export function stepMoment(current: number, direction: -1 | 1, step: number, from: number, to: number): number {
  const snapped = direction === 1 ? Math.floor(current / MINUTE) * MINUTE : Math.ceil(current / MINUTE) * MINUTE;
  return Math.min(to, Math.max(from, snapped + direction * step));
}

/**
 * Lists the moments something changed: the start of every stretch whose app or kind differs from the one
 * before it, or that follows a gap with nothing recorded. A new window title in the same app is not a change.
 * @param timeline The day's stretches, in time order.
 * @returns The moments, in time order.
 */
function changeMoments(timeline: TimelineItem[]): number[] {
  const changes: number[] = [];
  let previous: TimelineItem | undefined;
  for (const item of timeline) {
    const same = previous !== undefined && previous.end >= item.start && previous.kind === item.kind && previous.app === item.app;
    if (!same) {
      changes.push(item.start);
    }
    previous = item;
  }
  return changes;
}
