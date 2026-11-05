import { CalendarStore } from "../../src/main/calendar/CalendarStore";
import { MeetingTyper, buildRequest, readTypes } from "../../src/main/calendar/MeetingTyper";
import type { CalendarEvent } from "../../src/main/calendar/meetingLinks";
import { Store } from "../../src/main/store/Store";

const START = Date.parse("2026-11-05T15:00:00Z");

/**
 * Builds a calendar meeting.
 * @param id Its id.
 * @param extra Anything to override.
 * @returns The meeting.
 */
function event(id: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    eventId: id,
    title: `Meeting ${id}`,
    start: START,
    end: START + 30 * 60_000,
    response: "accepted",
    provider: "meet",
    joinUrl: null,
    seriesId: id,
    attendees: [{ email: "sam@qbdvision.com", name: "Sam" }],
    ...extra,
  };
}

/**
 * Builds a Messages API reply that calls the answer tool.
 * @param answers The tool's answers.
 * @returns The reply body.
 */
function toolReply(answers: unknown) {
  return { content: [{ type: "tool_use", name: "set_meeting_types", input: { answers } }] };
}

describe("buildRequest", () => {
  it("should send Haiku the title, the guests and your domain in Bedrock's shape, and force the answer tool", () => {
    const body = buildRequest(
      [event("a", { title: "Ryan / Sam", attendees: [{ email: "sam@acme.com", name: "Sam" }, { email: "kim@qbdvision.com", name: null }] })],
      "ryan@qbdvision.com",
    ) as { model?: string; anthropic_version: string; tool_choice: unknown; messages: { content: string }[] };
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
    expect(body.model).toBeUndefined();
    expect(body.tool_choice).toEqual({ type: "tool", name: "set_meeting_types" });
    expect(body.messages[0].content).toContain("My email domain is qbdvision.com");
    expect(body.messages[0].content).toContain(
      JSON.stringify([{ id: 0, title: "Ryan / Sam", attendees: ["Sam <sam@acme.com>", "kim@qbdvision.com"], more_attendees: 0 }]),
    );
  });
});

describe("readTypes", () => {
  it("should read one type per meeting, in the order sent", () => {
    expect(readTypes(toolReply([{ id: 1, type: "customer" }, { id: 0, type: "dsu" }]), 2)).toEqual(["dsu", "customer"]);
  });

  it("should turn a type it doesn't know into other", () => {
    expect(readTypes(toolReply([{ id: 0, type: "party" }]), 1)).toEqual(["other"]);
  });

  it("should give null for a meeting left out, ignore ids it wasn't sent, and fail when the tool wasn't called", () => {
    expect(readTypes(toolReply([{ id: 0, type: "dsu" }, { id: 7, type: "dsu" }, null]), 2)).toEqual(["dsu", null]);
    expect(() => readTypes({ content: [{ type: "text" }] }, 1)).toThrow("no meeting types");
  });
});

describe("MeetingTyper", () => {
  let store: Store;
  let calendar: CalendarStore;
  let requests: { messages: { content: string }[] }[];
  let reply: { error: string | null; body: unknown };

  beforeEach(() => {
    store = new Store(":memory:");
    calendar = new CalendarStore(store.db);
    requests = [];
    reply = { error: null, body: toolReply([{ id: 0, type: "one-on-one" }]) };
  });

  afterEach(() => store.close());

  /** A typer on the in-memory calendar with a fake Haiku. */
  const build = () =>
    new MeetingTyper({
      calendar,
      haiku: {
        invoke: async (body: object) => {
          requests.push(body as { messages: { content: string }[] });
          if (reply.error) {
            throw new Error(reply.error);
          }
          return reply.body;
        },
        describe: () => "your AWS keys from ~/.bashrc (us-east-1)",
      },
      ownEmail: () => "ryan@qbdvision.com",
      now: () => START,
    });

  it("should type each untyped series once, so every occurrence shares the type", async () => {
    calendar.replaceEvents(START - 1, START + 86_400_000 * 8, [
      event("w1", { seriesId: "weekly", start: START }),
      event("w2", { seriesId: "weekly", start: START + 86_400_000 * 7 }),
    ], START);
    await build().typeNew();
    expect(requests).toHaveLength(1);
    expect(calendar.listTypedEvents(START - 1, START + 86_400_000 * 8).map((typed) => [typed.eventId, typed.type, typed.typeSource])).toEqual([
      ["w1", "one-on-one", "haiku"],
      ["w2", "one-on-one", "haiku"],
    ]);
    await build().typeNew();
    expect(requests).toHaveLength(1);
  });

  it("should never send or change a type you picked", async () => {
    calendar.replaceEvents(START - 1, START + 86_400_000, [event("a"), event("b")], START);
    calendar.setMeetingType("a", "customer", "you", START);
    reply = { error: null, body: toolReply([{ id: 0, type: "dsu" }]) };
    await build().typeNew();
    expect(requests[0].messages[0].content).toContain("Meeting b");
    expect(requests[0].messages[0].content).not.toContain("Meeting a");
    calendar.setMeetingType("a", "dsu", "haiku", START);
    expect(calendar.listTypedEvents(START - 1, START + 86_400_000).map((typed) => typed.type)).toEqual(["customer", "dsu"]);
  });

  it("should keep Bedrock's error for Settings and leave the meeting untyped", async () => {
    calendar.replaceEvents(START - 1, START + 86_400_000, [event("a")], START);
    reply = { error: "Bedrock said: The security token included in the request is invalid.", body: null };
    const typer = build();
    await typer.typeNew();
    expect(typer.status()).toEqual({
      via: "your AWS keys from ~/.bashrc (us-east-1)",
      lastRunAt: null,
      lastError: "Bedrock said: The security token included in the request is invalid.",
    });
    expect(calendar.listTypedEvents(START - 1, START + 86_400_000)[0].type).toBeNull();
  });

  it("should leave declined meetings and blocks with nobody else invited unsorted", async () => {
    calendar.replaceEvents(START - 1, START + 86_400_000, [event("a", { response: "declined" }), event("b", { attendees: [] })], START);
    await build().typeNew();
    expect(requests).toHaveLength(0);
  });

  it("should keep the answers Haiku gave and send only the skipped meeting next time", async () => {
    calendar.replaceEvents(START - 1, START + 86_400_000, [event("a"), event("b", { start: START + 60_000 })], START);
    reply = { error: null, body: toolReply([{ id: 0, type: "customer" }]) };
    const typer = build();
    await typer.typeNew();
    expect(typer.status().lastError).toContain("skipped 1 of 2");
    expect(calendar.listTypedEvents(START - 1, START + 86_400_000).map((typed) => [typed.eventId, typed.type])).toEqual([
      ["a", null],
      ["b", "customer"],
    ]);
    reply = { error: null, body: toolReply([{ id: 0, type: "dsu" }]) };
    await typer.typeNew();
    expect(requests[1].messages[0].content).toContain("Meeting a");
    expect(requests[1].messages[0].content).not.toContain("Meeting b");
    expect(typer.status().lastError).toBeNull();
  });

  it("should sort again from Settings after waiting out a sort already under way", async () => {
    calendar.replaceEvents(START - 1, START + 86_400_000, [event("a")], START);
    reply = { error: "Bedrock said: throttled", body: null };
    const typer = build();
    // The first sort has already sent its request (and met the error) by the time typeNew returns.
    const running = typer.typeNew();
    reply = { error: null, body: toolReply([{ id: 0, type: "dsu" }]) };
    await Promise.all([running, typer.typeAgain()]);
    expect(requests).toHaveLength(2);
    expect(typer.status().lastError).toBeNull();
    expect(calendar.listTypedEvents(START - 1, START + 86_400_000)[0].type).toBe("dsu");
  });
});
