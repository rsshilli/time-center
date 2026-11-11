import type { CalendarEvent } from "../../src/main/calendar/meetingLinks";
import { isSoloTime } from "../../src/main/recording/callMeeting";

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
