import { describe, expect, it } from "vitest";
import type { DayMeeting, TimelineItem } from "../../src/shared/ipc";
import { awayMsIn, guessEntry, snapRange, suggestMeetings } from "../../src/renderer/manualEntry";
import { MINUTE } from "../../src/renderer/timelineStep";

const EIGHT = Date.UTC(2026, 10, 6, 8);

describe("snapRange", () => {
  it("should order a backwards drag, round to whole minutes and stay on the bar", () => {
    const bounds = { from: EIGHT, to: EIGHT + 60 * MINUTE };
    expect(snapRange(EIGHT + 20.6 * MINUTE, EIGHT - 5 * MINUTE, bounds)).toEqual({ from: EIGHT, to: EIGHT + 21 * MINUTE });
  });
});

describe("awayMsIn", () => {
  it("should count only the Away time inside the stretch", () => {
    const timeline = [
      { start: EIGHT, end: EIGHT + 10 * MINUTE, kind: "active" },
      { start: EIGHT + 10 * MINUTE, end: EIGHT + 30 * MINUTE, kind: "idle" },
    ] as TimelineItem[];
    expect(awayMsIn(timeline, { from: EIGHT + 5 * MINUTE, to: EIGHT + 20 * MINUTE })).toBe(10 * MINUTE);
  });

  it("should count time with no recording at all as Away, and time already filled by an entry as not", () => {
    const timeline = [
      { start: EIGHT, end: EIGHT + 10 * MINUTE, kind: "active", manual: { id: 1, eventId: null } },
    ] as TimelineItem[];
    expect(awayMsIn(timeline, { from: EIGHT, to: EIGHT + 30 * MINUTE })).toBe(20 * MINUTE);
  });
});

describe("guessEntry", () => {
  const block = (eventId: string, title: string) => ({ eventId, title, start: EIGHT, end: EIGHT + 60 * MINUTE }) as DayMeeting;
  const range = { from: EIGHT, to: EIGHT + 30 * MINUTE };

  it("should pick the overlapping meeting, or Driving when its title says you were driving", () => {
    expect(guessEntry([block("ws4", "QbD WS4")], range)).toEqual({ eventId: "ws4", category: "Meetings · Other" });
    expect(guessEntry([block("car", "Drive to the airport")], range)).toEqual({ eventId: null, category: "Driving" });
    expect(guessEntry([], range)).toEqual({ eventId: null, category: "Meetings · Other" });
  });
});

describe("suggestMeetings", () => {
  it("should put the meeting covering most of the stretch first and leave out ones it misses", () => {
    const meeting = (eventId: string, startMin: number, endMin: number) =>
      ({ eventId, start: EIGHT + startMin * MINUTE, end: EIGHT + endMin * MINUTE }) as DayMeeting;
    const meetings = [meeting("before", -60, 0), meeting("short", 0, 10), meeting("long", 5, 60)];
    expect(suggestMeetings(meetings, { from: EIGHT, to: EIGHT + 40 * MINUTE }).map((m) => m.eventId)).toEqual([
      "long",
      "short",
    ]);
  });
});
