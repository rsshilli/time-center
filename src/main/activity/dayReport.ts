import type { CategoryRule, DayReport, TimelineItem, Total } from "../../shared/ipc";
import type { ActivityStore } from "./ActivityStore";
import { AWAY, UNTRACKED, categorize } from "./classify";

/**
 * Builds everything the dashboard shows for the local day containing a moment. Categories are worked
 * out here, on read, so edited rules apply to past days too.
 * @param store The activity tables.
 * @param rules The category rules.
 * @param at Any moment in the day.
 * @returns The day's report.
 */
export function buildDayReport(
  store: Pick<ActivityStore, "listSegments" | "listScreenshots">,
  rules: readonly CategoryRule[],
  at: number,
): DayReport {
  const { dayStart, dayEnd } = localDayBounds(at);
  const timeline: TimelineItem[] = store
    .listSegments(dayStart, dayEnd)
    .map((segment) => ({
      start: Math.max(segment.startedAt, dayStart),
      end: Math.min(segment.endedAt, dayEnd),
      kind: segment.kind,
      category: categoryFor(segment, rules),
      app: segment.app,
      title: segment.title,
      url: segment.url,
      domain: segment.domain,
      project: segment.project,
    }))
    .filter((item) => item.end > item.start);
  const active = timeline.filter((item) => item.kind === "active");
  return {
    dayStart,
    dayEnd,
    timeline,
    screenshots: store.listScreenshots(dayStart, dayEnd).map((shot) => ({
      id: shot.id,
      takenAt: shot.takenAt,
      status: shot.status,
      displayId: shot.displayId,
    })),
    activeMs: sumMs(active),
    idleMs: sumMs(timeline.filter((item) => item.kind === "idle")),
    untrackedMs: sumMs(timeline.filter((item) => item.kind === "untracked")),
    byCategory: totalBy(active, (item) => item.category),
    byApp: totalBy(active, (item) => item.app),
    byProject: totalBy(active, (item) => item.project),
    byDomain: totalBy(active, (item) => item.domain),
  };
}

/**
 * Finds local midnight before and after a moment. Uses calendar arithmetic, so days with a daylight
 * saving change come out 23 or 25 hours long.
 * @param at Any moment in the day.
 * @returns The day's start and end, in milliseconds.
 */
export function localDayBounds(at: number): { dayStart: number; dayEnd: number } {
  const start = new Date(at);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { dayStart: start.getTime(), dayEnd: end.getTime() };
}

/**
 * Picks a stretch's category: Away and Untracked for those kinds, the rules for active time.
 * @param segment The stretch.
 * @param rules The rules.
 * @returns The category.
 */
function categoryFor(segment: Parameters<typeof categorize>[0] & { kind: string }, rules: readonly CategoryRule[]): string {
  if (segment.kind === "idle") {
    return AWAY;
  }
  if (segment.kind === "untracked") {
    return UNTRACKED;
  }
  return categorize(segment, rules);
}

/**
 * Adds up the length of some stretches.
 * @param items The stretches.
 * @returns Total milliseconds.
 */
function sumMs(items: readonly TimelineItem[]): number {
  return items.reduce((sum, item) => sum + (item.end - item.start), 0);
}

/**
 * Adds up time per name, largest first. Stretches without a name are left out.
 * @param items The stretches.
 * @param nameOf Picks the name to group by.
 * @returns One total per name.
 */
function totalBy(items: readonly TimelineItem[], nameOf: (item: TimelineItem) => string | null): Total[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    const name = nameOf(item);
    if (name) {
      totals.set(name, (totals.get(name) ?? 0) + (item.end - item.start));
    }
  }
  return [...totals.entries()].map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms);
}
