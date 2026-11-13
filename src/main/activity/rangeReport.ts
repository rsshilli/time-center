import { MAX_RANGE_DAYS, type CategoryRule, type DayReport, type RangeReport, type Total } from "../../shared/ipc";
import type { ActivityStore } from "./ActivityStore";
import { buildDayReport, localDayBounds } from "./dayReport";
import type { MeetingForDay } from "./meetingTime";

/**
 * Builds your time over several days by building each day's report the usual way and adding them up, so
 * rules, marked stretches and meeting time come out exactly as they do on the day itself.
 * @param store The activity tables.
 * @param rules The category rules.
 * @param from Any moment in the first day.
 * @param to The end of the range; a day starting before it is included.
 * @param listMeetings Reads the calendar meetings overlapping a window, with their types.
 * @returns The range's totals, and each day's for its bar.
 */
export function buildRangeReport(
  store: Pick<ActivityStore, "listSegments" | "listManualEntries">,
  rules: readonly CategoryRule[],
  from: number,
  to: number,
  listMeetings: (from: number, to: number) => readonly MeetingForDay[] = () => [],
): RangeReport {
  // Screenshots aren't shown for a range, so none are read.
  const withoutShots = { ...pick(store), listScreenshots: () => [] };
  const reports: DayReport[] = [];
  for (let at = localDayBounds(from).dayStart; at < to && reports.length < MAX_RANGE_DAYS; at = localDayBounds(at).dayEnd) {
    reports.push(buildDayReport(withoutShots, rules, at, listMeetings));
  }
  const start = reports[0]?.dayStart ?? localDayBounds(from).dayStart;
  return {
    from: start,
    to: reports.at(-1)?.dayEnd ?? start,
    days: reports.map((report) => ({ dayStart: report.dayStart, activeMs: report.activeMs, byCategory: report.byCategory })),
    activeMs: sum(reports, (report) => report.activeMs),
    idleMs: sum(reports, (report) => report.idleMs),
    untrackedMs: sum(reports, (report) => report.untrackedMs),
    byCategory: addTotals(reports.map((report) => report.byCategory)),
    byApp: addTotals(reports.map((report) => report.byApp)),
    byProject: addTotals(reports.map((report) => report.byProject)),
    byDomain: addTotals(reports.map((report) => report.byDomain)),
    byMeeting: addTotals(
      reports.map((report) =>
        report.meetings.filter((meeting) => meeting.attended && meeting.ms > 0).map((meeting) => ({ name: meeting.title, ms: meeting.ms })),
      ),
    ),
  };
}

/**
 * Keeps only the store's read methods the day report needs, bound to the store.
 * @param store The activity tables.
 * @returns Its segment and marked-stretch readers.
 */
function pick(store: Pick<ActivityStore, "listSegments" | "listManualEntries">) {
  return {
    listSegments: store.listSegments.bind(store),
    listManualEntries: store.listManualEntries.bind(store),
  };
}

/**
 * Adds up a number over the days.
 * @param reports The days.
 * @param valueOf Picks the number.
 * @returns The sum.
 */
function sum(reports: readonly DayReport[], valueOf: (report: DayReport) => number): number {
  return reports.reduce((total, report) => total + valueOf(report), 0);
}

/**
 * Merges lists of totals by name, largest first.
 * @param lists One list per day.
 * @returns One total per name.
 */
function addTotals(lists: readonly (readonly Total[])[]): Total[] {
  const totals = new Map<string, number>();
  for (const total of lists.flat()) {
    totals.set(total.name, (totals.get(total.name) ?? 0) + total.ms);
  }
  return [...totals.entries()].map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms);
}
