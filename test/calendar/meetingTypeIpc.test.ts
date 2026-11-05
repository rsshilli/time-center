import { CalendarStore } from "../../src/main/calendar/CalendarStore";
import { assertMeetingType, setMeetingTypeByYou } from "../../src/main/calendar/meetingTypeIpc";
import { Store } from "../../src/main/store/Store";

const START = Date.parse("2026-11-05T15:00:00Z");

describe("setMeetingTypeByYou", () => {
  it("should set the type for every occurrence of the meeting's series", () => {
    const store = new Store(":memory:");
    const calendar = new CalendarStore(store.db);
    const occurrence = (eventId: string, start: number) => ({
      eventId,
      title: "Ryan / Sam",
      start,
      end: start + 1_800_000,
      response: "accepted",
      provider: null,
      joinUrl: null,
      seriesId: "weekly",
      attendees: [],
    });
    calendar.replaceEvents(START - 1, START + 86_400_000 * 8, [occurrence("w1", START), occurrence("w2", START + 86_400_000 * 7)], START);
    setMeetingTypeByYou({ calendar, now: () => START }, "w2", "one-on-one");
    expect(calendar.listTypedEvents(START - 1, START + 86_400_000 * 8).map((typed) => [typed.type, typed.typeSource])).toEqual([
      ["one-on-one", "you"],
      ["one-on-one", "you"],
    ]);
    expect(() => setMeetingTypeByYou({ calendar, now: () => START }, "gone", "dsu")).toThrow("no longer on the calendar");
    store.close();
  });
});

describe("assertMeetingType", () => {
  it("should accept the six types and refuse anything else", () => {
    expect(assertMeetingType("customer")).toBe("customer");
    expect(() => assertMeetingType("toString")).toThrow("Not a meeting type");
    expect(() => assertMeetingType(3)).toThrow("Not a meeting type");
  });
});
