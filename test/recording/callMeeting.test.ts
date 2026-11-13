import type { CalendarEvent } from "../../src/main/calendar/meetingLinks";
import type { StoredRecording } from "../../src/main/recording/RecordingStore";
import { callSections, callTitle, isSoloTime, type CallWindow } from "../../src/main/recording/callMeeting";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 11, 17, 50);

/**
 * A meeting running across NOW.
 * @param changes What differs from a block with nobody else on it and no link.
 * @returns The meeting.
 */
function meeting(changes: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    eventId: "e1",
    title: "Ryan gets things done",
    start: NOW - HOUR,
    end: NOW + HOUR,
    response: "accepted",
    provider: null,
    joinUrl: null,
    seriesId: "e1",
    attendees: [],
    ...changes,
  };
}

describe("isSoloTime", () => {
  it("should be true during a block with nobody else on it and no call link", () => {
    expect(isSoloTime([meeting()], NOW)).toBe(true);
  });

  it("should be false with no meeting on, or once the block has ended", () => {
    expect(isSoloTime([], NOW)).toBe(false);
    expect(isSoloTime([meeting({ end: NOW })], NOW)).toBe(false);
  });

  it("should be false when a meeting with other people or a call link is on at the same time", () => {
    const others = meeting({ eventId: "e2", title: "Weekly sync", attendees: [{ email: "dana@example.com", name: "Dana" }] });
    const linked = meeting({ eventId: "e3", provider: "zoom", joinUrl: "https://zoom.us/j/1" });
    expect(isSoloTime([meeting(), others], NOW)).toBe(false);
    expect(isSoloTime([meeting(), linked], NOW)).toBe(false);
  });

  it("should ignore a declined meeting", () => {
    expect(isSoloTime([meeting({ response: "declined" })], NOW)).toBe(false);
  });
});

/** Nov 12 2026 at a UTC clock time ("15:59:41"). */
const at = (clock: string) => Date.parse(`2026-11-12T${clock}Z`);

/** One person invited, so a meeting counts as a real one. */
const GUEST = [{ email: "guest@example.com", name: "Guest" }];

/**
 * A meeting on Nov 12 2026, as the calendar had it.
 * @param title Its title.
 * @param start Its start, UTC clock.
 * @param end Its end, UTC clock.
 * @param changes What else differs from an accepted Zoom meeting.
 * @returns The meeting.
 */
function dayMeeting(title: string, start: string, end: string, changes: Partial<CalendarEvent> = {}): CalendarEvent {
  return meeting({ eventId: title, seriesId: title, title, start: at(start), end: at(end), provider: "zoom", attendees: GUEST, ...changes });
}

/** The real meetings of Nov 12 2026, 10:00 to 3:30 EST (two overlap at 12:30: Meet accepted, Teams maybe). */
const NOV_12 = [
  dayMeeting("Engineering Sprint Demo", "15:00:00", "15:55:00"),
  dayMeeting("Innovation Team DSU", "16:00:00", "16:30:00"),
  dayMeeting("Frank & Ryan", "16:30:00", "17:00:00"),
  dayMeeting("Dept. OB: Innovation", "17:30:00", "18:00:00", { provider: "meet", joinUrl: "https://meet.google.com/twr-tend-hrq" }),
  dayMeeting("QbD WS4 - Working Session", "17:30:00", "18:30:00", { provider: "teams", response: "tentative" }),
  dayMeeting("Ryan & Kons 1-1", "18:30:00", "19:00:00"),
  dayMeeting("Ryan Shillington, investment ideas", "19:00:00", "19:30:00"),
];

/** The meeting windows that came to the front during that day's long call, from the activity log. */
const NOV_12_WINDOWS: CallWindow[] = [
  { startedAt: at("15:59:35"), app: "Zoom", title: "Zoom Meeting", url: null },
  { startedAt: at("16:29:08"), app: "Zoom", title: "Zoom Meeting", url: null },
  { startedAt: at("17:02:41"), app: "Zoom", title: "Zoom Meeting", url: null },
  { startedAt: at("17:29:44"), app: "Google Chrome", title: "Meet - Dept. OB: Innovation - Camera and microphone", url: "https://meet.google.com/meet/twr-tend-hrq?authuser=0" },
  { startedAt: at("17:30:02"), app: "Zoom", title: "Zoom Workplace", url: null },
  { startedAt: at("17:32:53"), app: "Google Chrome", title: "Meet - Dept. OB: Innovation - Ryan (qbdvision.com)", url: "about:blank" },
  { startedAt: at("18:03:38"), app: "Microsoft Teams", title: "Meeting join | Microsoft Teams meeting | QbDVision", url: null },
  { startedAt: at("18:03:53"), app: "Microsoft Teams", title: "QbD WS4 Kickoff | QbDVision, Inc. | ryan@qbdvision.com", url: null },
  { startedAt: at("18:29:33"), app: "Zoom", title: "Zoom Meeting", url: null },
  { startedAt: at("18:30:14"), app: "Microsoft Teams", title: "QbD WS4 Kickoff | QbDVision, Inc. | ryan@qbdvision.com", url: null },
  { startedAt: at("18:31:50"), app: "Zoom", title: "Zoom Meeting", url: null },
];

/**
 * A finished call.
 * @param start Its start, UTC clock.
 * @param end Its end, UTC clock.
 * @returns The recording.
 */
function call(start: string, end: string): StoredRecording {
  return { id: 35, start: at(start), end: at(end), folder: "/tmp/35", audioPath: null, mic: true, error: null, audioDeleted: false };
}

/**
 * Each section as "title start–end" in UTC clock times, for reading a failure.
 * @param sections The sections.
 * @returns One line each.
 */
function sectionLines(sections: ReturnType<typeof callSections>): string[] {
  const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);
  return sections.map((section) => `${section.meeting.title} ${clock(section.start)}-${clock(section.end)}`);
}

describe("callSections", () => {
  it("should split Nov 12's three-hour call into the five meetings it ran through", () => {
    const sections = callSections(call("15:59:41", "19:02:02"), NOV_12, NOV_12_WINDOWS, at("21:00:00"));
    expect(sectionLines(sections)).toEqual([
      "Innovation Team DSU 15:59:41-16:30:00",
      "Frank & Ryan 16:30:00-17:30:00",
      "Dept. OB: Innovation 17:30:00-18:00:00",
      "QbD WS4 - Working Session 18:00:00-18:30:00",
      "Ryan & Kons 1-1 18:30:00-19:02:02",
    ]);
  });

  it("should put the accepted meeting before the maybe that overlaps it, with no windows to go on", () => {
    const sections = callSections(call("17:29:00", "18:25:00"), NOV_12, [], at("21:00:00"));
    expect(sectionLines(sections)).toEqual(["Dept. OB: Innovation 17:29:00-18:00:00", "QbD WS4 - Working Session 18:00:00-18:25:00"]);
  });

  it("should follow the window you're in over the accepted meeting", () => {
    const teams: CallWindow[] = [{ startedAt: at("17:30:30"), app: "Microsoft Teams", title: "QbD WS4 Kickoff | QbDVision, Inc.", url: null }];
    const sections = callSections(call("17:30:00", "18:20:00"), NOV_12, teams, at("21:00:00"));
    expect(sectionLines(sections)).toEqual(["QbD WS4 - Working Session 17:30:00-18:20:00"]);
  });

  it("should match a Meet tab by its code and leave a glance at another window inside the meeting", () => {
    const windows: CallWindow[] = [
      { startedAt: at("17:31:00"), app: "Google Chrome", title: "Meet", url: "https://meet.google.com/twr-tend-hrq" },
      { startedAt: at("17:40:00"), app: "Microsoft Teams", title: "QbD WS4 Kickoff | QbDVision, Inc.", url: null },
      { startedAt: at("17:41:00"), app: "Google Chrome", title: "Meet", url: "https://meet.google.com/twr-tend-hrq" },
    ];
    const sections = callSections(call("17:30:00", "17:55:00"), NOV_12, windows, at("21:00:00"));
    expect(sectionLines(sections)).toEqual(["Dept. OB: Innovation 17:30:00-17:55:00"]);
  });

  it("should give a call inside one meeting just that meeting, and a call outside every meeting none", () => {
    expect(sectionLines(callSections(call("19:03:53", "19:32:38"), NOV_12, [], at("21:00:00")))).toEqual([
      "Ryan Shillington, investment ideas 19:03:53-19:32:38",
    ]);
    expect(callSections(call("21:00:00", "21:20:00"), NOV_12, [], at("22:00:00"))).toEqual([]);
  });

  it("should prefer a meeting with other people over a block for yourself, but use the block when it's all there is", () => {
    const block = dayMeeting("Pay credit card", "20:00:00", "21:00:00", { provider: null, attendees: [] });
    const real = dayMeeting("Robotics", "20:30:00", "21:00:00");
    expect(sectionLines(callSections(call("20:31:00", "20:50:00"), [block, real], [], at("22:00:00")))).toEqual(["Robotics 20:31:00-20:50:00"]);
    expect(sectionLines(callSections(call("20:10:00", "20:20:00"), [block], [], at("22:00:00")))).toEqual(["Pay credit card 20:10:00-20:20:00"]);
  });

  it("should end a call still going at now and leave out a declined meeting", () => {
    const live = { ...call("18:31:00", "18:31:00"), end: null };
    const declined = dayMeeting("Skipped", "18:30:00", "19:00:00", { response: "declined" });
    expect(sectionLines(callSections(live, [declined, ...NOV_12], [], at("18:45:00")))).toEqual(["Ryan & Kons 1-1 18:31:00-18:45:00"]);
  });
});

describe("callTitle", () => {
  it("should list each meeting once, in order, or give null for none", () => {
    const sections = callSections(call("17:29:00", "18:25:00"), NOV_12, [], at("21:00:00"));
    expect(callTitle(sections)).toBe("Dept. OB: Innovation · QbD WS4 - Working Session");
    expect(callTitle([])).toBeNull();
  });
});
