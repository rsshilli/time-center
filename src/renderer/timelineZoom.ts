import { MINUTE } from "./timelineStep";

/** A stretch of the day the timeline shows, in milliseconds. */
export interface TimeRange {
  from: number;
  to: number;
}

/** The narrowest the timeline zooms to: ten minutes across the whole bar. */
export const MIN_SPAN = 10 * MINUTE;

/** How much one notch of the scroll wheel (100 pixels of scrolling) zooms by. */
const ZOOM_PER_NOTCH = 1.25;

/** Gaps between the time labels under the bar; the first that leaves at most a dozen labels is used. */
const TICK_STEPS = [MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, 60 * MINUTE, 120 * MINUTE];

/**
 * Zooms the shown range in or out around a moment, which stays at the same spot on the bar. Never narrower
 * than `MIN_SPAN`, never wider than the whole range, never outside it.
 * @param view What the timeline shows now.
 * @param full Everything it can show.
 * @param anchor The moment to zoom around.
 * @param wheelDelta The wheel's vertical scroll: negative (scroll up) zooms in, positive zooms out.
 * @returns The new range.
 */
export function zoomRange(view: TimeRange, full: TimeRange, anchor: number, wheelDelta: number): TimeRange {
  const span = view.to - view.from;
  const fullSpan = full.to - full.from;
  const wanted = span * ZOOM_PER_NOTCH ** (wheelDelta / 100);
  const newSpan = Math.min(fullSpan, Math.max(Math.min(MIN_SPAN, fullSpan), wanted));
  const ratio = Math.min(1, Math.max(0, (anchor - view.from) / span));
  return fitInside(anchor - ratio * newSpan, newSpan, full);
}

/**
 * Slides the shown range earlier or later without changing its width.
 * @param view What the timeline shows now.
 * @param full Everything it can show.
 * @param shift How far to move: negative is earlier.
 * @returns The new range.
 */
export function panRange(view: TimeRange, full: TimeRange, shift: number): TimeRange {
  return fitInside(view.from + shift, view.to - view.from, full);
}

/**
 * Slides the shown range just enough that a moment is on it, e.g. when the arrow keys walk off the edge.
 * @param view What the timeline shows now.
 * @param full Everything it can show.
 * @param moment The moment that must be visible.
 * @returns The range, unchanged if the moment is already on it.
 */
export function keepInView(view: TimeRange, full: TimeRange, moment: number): TimeRange {
  if (moment < view.from) {
    return panRange(view, full, moment - view.from);
  }
  if (moment > view.to) {
    return panRange(view, full, moment - view.to);
  }
  return view;
}

/**
 * Lists the moments to label under the bar, on round times, spaced to suit how far it is zoomed in.
 * @param view What the timeline shows.
 * @param dayStart Local midnight, so labels fall on round local times.
 * @returns The labelled moments, all inside the range.
 */
export function tickMoments(view: TimeRange, dayStart: number): number[] {
  const span = view.to - view.from;
  const step = TICK_STEPS.find((candidate) => span / candidate <= 12) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: number[] = [];
  for (let tick = dayStart + Math.ceil((view.from - dayStart) / step) * step; tick <= view.to; tick += step) {
    ticks.push(tick);
  }
  return ticks;
}

/**
 * Places a range of a given width as close as it can to a start, without leaving the whole range.
 * @param from The wanted start.
 * @param span The width.
 * @param full Everything that can be shown.
 * @returns The placed range.
 */
function fitInside(from: number, span: number, full: TimeRange): TimeRange {
  const start = Math.min(full.to - span, Math.max(full.from, from));
  return { from: start, to: start + span };
}
