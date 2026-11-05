import { splitMeetingTime, type MeetingForDay } from "../../src/main/activity/meetingTime";
import type { TimelineItem } from "../../src/shared/ipc";

const MIN = 60_000;
const T0 = Date.parse("2026-11-05T15:00:00Z");

/**
 * Builds a stretch of the timeline.
 * @param startMin Minutes after T0 it starts.
 * @param endMin Minutes after T0 it ends.
 * @param category Its category from the rules.
 * @param extra Anything to override (kind, onCall…).
 * @returns The stretch.
 */
function item(startMin: number, endMin: number, category: string, extra: Partial<TimelineItem> = {}): TimelineItem {
  return {
    start: T0 + startMin * MIN,
    end: T0 + endMin * MIN,
    kind: "active",
    category,
    app: null,
    title: null,
    url: null,
    domain: null,
    project: null,
    ...extra,
  };
}

/**
 * Builds a calendar meeting with a call link and one other guest.
 * @param id Its id.
 * @param startMin Minutes after T0 it starts.
 * @param endMin Minutes after T0 it ends.
 * @param extra Anything to override.
 * @returns The meeting.
 */
function meeting(id: string, startMin: number, endMin: number, extra: Partial<MeetingForDay> = {}): MeetingForDay {
  return {
    eventId: id,
    title: id,
    start: T0 + startMin * MIN,
    end: T0 + endMin * MIN,
    response: "accepted",
    type: "dsu",
    typeSource: "haiku",
    joinUrl: "https://meet.google.com/abc-defg-hij",
    attendees: [{ email: "sam@qbdvision.com", name: null }],
    ...extra,
  };
}

/**
 * Lists each stretch as "start-end category" in minutes, for readable expectations.
 * @param timeline The stretches.
 * @returns One line per stretch.
 */
function lines(timeline: TimelineItem[]): string[] {
  return timeline.map((piece) => `${(piece.start - T0) / MIN}-${(piece.end - T0) / MIN} ${piece.category}`);
}

describe("splitMeetingTime", () => {
  it("should put all active time during an attended meeting under its type, whatever app was in front", () => {
    const result = splitMeetingTime(
      [item(-10, 5, "Code"), item(5, 12, "Meetings"), item(12, 20, "Slack"), item(20, 30, "Code")],
      [meeting("standup", 0, 15)],
    );
    expect(lines(result.timeline)).toEqual([
      "-10-0 Code",
      "0-5 Meetings · DSU",
      "5-12 Meetings · DSU",
      "12-15 Meetings · DSU",
      "15-20 Slack",
      "20-30 Code",
    ]);
    expect(result.meetings).toEqual([expect.objectContaining({ eventId: "standup", attended: true, ms: 15 * MIN })]);
  });

  it("should count a call in any app as attending, by the microphone", () => {
    const result = splitMeetingTime([item(0, 30, "Chat", { onCall: true })], [meeting("huddle", 0, 30, { type: "architecture" })]);
    expect(lines(result.timeline)).toEqual(["0-30 Meetings · Architecture/product review"]);
  });

  it("should leave a meeting you were never on a call for alone, and leave out declined ones", () => {
    const result = splitMeetingTime(
      [item(0, 30, "Code")],
      [meeting("skipped", 0, 15), meeting("declined", 15, 30, { response: "declined" })],
    );
    expect(lines(result.timeline)).toEqual(["0-30 Code"]);
    expect(result.meetings).toEqual([expect.objectContaining({ eventId: "skipped", attended: false, ms: 0 })]);
  });

  it("should not count a meeting that a call only ran a couple of minutes into", () => {
    const result = splitMeetingTime(
      [item(0, 32, "Meetings"), item(32, 60, "Code")],
      [meeting("first", 0, 30, { type: "management" }), meeting("next", 30, 60, { type: "customer" })],
    );
    expect(lines(result.timeline)).toEqual(["0-30 Meetings · Management/Exec", "30-32 Meetings · Other", "32-60 Code"]);
    expect(result.meetings.map((day) => [day.eventId, day.attended])).toEqual([
      ["first", true],
      ["next", false],
    ]);
  });

  it("should give a double-booked slot's call to the meeting it started in, not the one you skipped", () => {
    const result = splitMeetingTime(
      [item(0, 50, "Meetings"), item(50, 90, "Code")],
      [meeting("a", 0, 60, { type: "customer" }), meeting("b", 30, 90, { type: "one-on-one" })],
    );
    expect(lines(result.timeline)).toEqual(["0-50 Meetings · Customer", "50-60 Meetings · Customer", "60-90 Code"]);
    expect(result.meetings.map((day) => [day.eventId, day.attended, day.ms / MIN])).toEqual([
      ["a", true, 60],
      ["b", false, 0],
    ]);
  });

  it("should give a short meeting inside a longer one its own call, and the rest to the longer one", () => {
    const result = splitMeetingTime(
      [item(0, 30, "Meetings"), item(30, 45, "Meetings", { app: "Zoom" }), item(45, 60, "Code")],
      [meeting("long", 0, 60, { type: "management" }), meeting("one-on-one", 30, 45, { type: "one-on-one" })],
    );
    expect(lines(result.timeline)).toEqual([
      "0-30 Meetings · Management/Exec",
      "30-45 Meetings · One on ones",
      "45-60 Meetings · Management/Exec",
    ]);
    expect(result.meetings.map((day) => [day.eventId, day.ms / MIN])).toEqual([
      ["long", 45],
      ["one-on-one", 15],
    ]);
  });

  it("should count an accepted in-person meeting (guests, no call link) as attended", () => {
    const result = splitMeetingTime([item(0, 30, "Code")], [meeting("offsite", 0, 30, { joinUrl: null, type: "management" })]);
    expect(lines(result.timeline)).toEqual(["0-30 Meetings · Management/Exec"]);
  });

  it("should keep plain Meetings on a day with no calendar meetings, and while a meeting has no type", () => {
    expect(lines(splitMeetingTime([item(0, 10, "Meetings")], []).timeline)).toEqual(["0-10 Meetings"]);
    const untyped = splitMeetingTime([item(0, 10, "Meetings")], [meeting("new", 0, 30, { type: null, typeSource: null })]);
    expect(lines(untyped.timeline)).toEqual(["0-10 Meetings"]);
  });

  it("should put call time outside every meeting in Meetings · Other when the day has calendar meetings", () => {
    const result = splitMeetingTime([item(40, 50, "Meetings")], [meeting("standup", 0, 15)]);
    expect(lines(result.timeline)).toEqual(["40-50 Meetings · Other"]);
  });

  it("should list blocks with nobody else invited only when you were on a call in them", () => {
    const result = splitMeetingTime(
      [item(30, 40, "Meetings")],
      [meeting("Drive", 0, 20, { attendees: [], joinUrl: null }), meeting("Focus call", 30, 40, { attendees: [] })],
    );
    expect(result.meetings.map((day) => day.eventId)).toEqual(["Focus call"]);
  });

  it("should leave away time as away, even during a meeting", () => {
    const result = splitMeetingTime([item(0, 6, "Meetings"), item(6, 10, "Away", { kind: "idle" })], [meeting("standup", 0, 10)]);
    expect(lines(result.timeline)).toEqual(["0-6 Meetings · DSU", "6-10 Away"]);
  });
});
