import { CalendarStore } from "../../src/main/calendar/CalendarStore";
import { JoinScheduler, LATE_JOIN_LIMIT_MS } from "../../src/main/calendar/JoinScheduler";
import type { CalendarEvent } from "../../src/main/calendar/meetingLinks";
import type { JoinMode } from "../../src/shared/ipc";
import { Store } from "../../src/main/store/Store";

const START = Date.parse("2026-11-05T15:00:00Z");

describe("JoinScheduler", () => {
  let store: Store;
  let calendar: CalendarStore;
  let clock: number;
  let mode: JoinMode;
  let notices: { title: string; joinAt: number; skip: () => void; closed: boolean }[];
  let reminders: { title: string; join: () => void; closed: boolean }[];
  let joined: string[];
  let failures: string[];
  let joinError: Error | null;

  beforeEach(() => {
    store = new Store(":memory:");
    calendar = new CalendarStore(store.db);
    clock = START - 10 * 60_000;
    mode = "join";
    notices = [];
    reminders = [];
    joined = [];
    failures = [];
    joinError = null;
  });

  afterEach(() => store.close());

  /** A scheduler on the in-memory calendar, a fake clock, and fake notices and joins. */
  const build = () =>
    new JoinScheduler({
      calendar,
      joinMode: () => mode,
      notify: (event, joinAt, onSkip) => {
        const notice = { title: event.title, joinAt, skip: onSkip, closed: false };
        notices.push(notice);
        return {
          close: () => {
            notice.closed = true;
          },
        };
      },
      remind: (event, onJoin) => {
        const reminder = { title: event.title, join: onJoin, closed: false };
        reminders.push(reminder);
        return {
          close: () => {
            reminder.closed = true;
          },
        };
      },
      join: async (event) => {
        if (joinError) {
          throw joinError;
        }
        joined.push(event.eventId);
      },
      reportFailure: (_event, error) => failures.push(error),
      onChange: () => {},
      now: () => clock,
    });

  /**
   * Stores meetings as a sync would.
   * @param events The meetings, each starting at START unless given.
   */
  const meetings = (...events: Partial<CalendarEvent>[]) =>
    calendar.replaceEvents(
      START - 86_400_000,
      START + 86_400_000,
      events.map((event, index) => ({
        eventId: `e${index}`,
        title: `Meeting ${index}`,
        start: START,
        end: START + 30 * 60_000,
        response: "accepted",
        provider: "meet",
        joinUrl: "https://meet.google.com/abc-defg-hij",
        seriesId: `e${index}`,
        attendees: [],
        ...event,
      })),
      clock,
    );

  /**
   * Moves the fake clock to a moment and lets the scheduler (and any join it starts) run.
   * @param scheduler The scheduler.
   * @param at The moment.
   */
  const tickAt = async (scheduler: JoinScheduler, at: number) => {
    clock = at;
    scheduler.tick();
    await Promise.resolve();
    await Promise.resolve();
  };

  it("should put up a notice a minute before the start and join 30 seconds before it", async () => {
    meetings({ title: "Standup" });
    const scheduler = build();
    await tickAt(scheduler, START - 61_000);
    expect(notices).toHaveLength(0);
    await tickAt(scheduler, START - 60_000);
    expect(notices).toMatchObject([{ title: "Standup", joinAt: START - 30_000, closed: false }]);
    await tickAt(scheduler, START - 31_000);
    expect(joined).toEqual([]);
    await tickAt(scheduler, START - 30_000);
    expect(joined).toEqual(["e0"]);
    expect(notices[0].closed).toBe(true);
    expect(calendar.getJoin("e0", START)).toBe("joined");
  });

  it("should join each meeting once, even across ticks and restarts", async () => {
    meetings({});
    const scheduler = build();
    await tickAt(scheduler, START - 60_000);
    await tickAt(scheduler, START - 30_000);
    await tickAt(scheduler, START - 29_000);
    const restarted = build();
    await tickAt(restarted, START);
    await tickAt(restarted, START + 30_000);
    expect(joined).toEqual(["e0"]);
    expect(notices).toHaveLength(1);
  });

  it("should not join when the notice is clicked to skip", async () => {
    meetings({});
    const scheduler = build();
    await tickAt(scheduler, START - 60_000);
    notices[0].skip();
    await tickAt(scheduler, START - 30_000);
    expect(joined).toEqual([]);
    expect(calendar.getJoin("e0", START)).toBe("skipped");
    expect(scheduler.meetings()[0].state).toBe("skipped");
  });

  it("should give a meeting found at its join time the full 30-second notice", async () => {
    meetings({});
    const scheduler = build();
    await tickAt(scheduler, START - 30_000);
    expect(joined).toEqual([]);
    await tickAt(scheduler, START);
    expect(joined).toEqual(["e0"]);
  });

  it("should join a meeting found after its start, 30 seconds after the notice", async () => {
    meetings({});
    const scheduler = build();
    await tickAt(scheduler, START + 2 * 60_000);
    expect(notices[0].joinAt).toBe(START + 2 * 60_000 + 30_000);
    await tickAt(scheduler, START + 2 * 60_000 + 30_000);
    expect(joined).toEqual(["e0"]);
  });

  it("should leave a meeting alone once it's more than five minutes in", async () => {
    meetings({});
    const scheduler = build();
    await tickAt(scheduler, START + LATE_JOIN_LIMIT_MS + 1000);
    expect(notices).toHaveLength(0);
    expect(scheduler.meetings()[0].state).toBe("missed");
  });

  it("should take the notice down when the Mac sleeps through the join window", async () => {
    meetings({});
    const scheduler = build();
    await tickAt(scheduler, START - 60_000);
    await tickAt(scheduler, START + LATE_JOIN_LIMIT_MS + 60_000);
    expect(notices[0].closed).toBe(true);
    expect(joined).toEqual([]);
  });

  it("should not join declined meetings, meetings with no link, or anything while auto-join is off", async () => {
    meetings({ response: "declined" }, { joinUrl: null, provider: null });
    const scheduler = build();
    await tickAt(scheduler, START - 30_000);
    expect(notices).toHaveLength(0);
    expect(scheduler.meetings().map((meeting) => meeting.state)).toEqual(["declined", "no-link"]);

    meetings({});
    mode = "off";
    await tickAt(scheduler, START - 30_000);
    expect(notices).toHaveLength(0);
    expect(reminders).toHaveLength(0);
    expect(scheduler.meetings()[0].state).toBe("auto-join-off");
  });

  it("should take the notice down when auto-join is turned off during it", async () => {
    meetings({});
    const scheduler = build();
    await tickAt(scheduler, START - 60_000);
    mode = "off";
    await tickAt(scheduler, START - 30_000);
    expect(notices[0].closed).toBe(true);
    expect(joined).toEqual([]);
  });

  it("should record and report a join that failed", async () => {
    meetings({});
    joinError = new Error("Couldn't open Google Chrome. Is it installed?");
    const scheduler = build();
    await tickAt(scheduler, START - 60_000);
    await tickAt(scheduler, START - 30_000);
    expect(calendar.getJoin("e0", START)).toBe("failed");
    expect(failures).toEqual(["Couldn't open Google Chrome. Is it installed?"]);
  });

  it("should decide a moved meeting afresh", async () => {
    meetings({});
    const scheduler = build();
    await tickAt(scheduler, START - 60_000);
    notices[0].skip();
    meetings({ start: START + 3_600_000, end: START + 5_400_000 });
    await tickAt(scheduler, START + 3_600_000 - 60_000);
    await tickAt(scheduler, START + 3_600_000 - 30_000);
    expect(joined).toEqual(["e0"]);
  });

  it("should join at once on request, whatever the setting, and not again at the join time", async () => {
    meetings({ response: "declined" });
    mode = "off";
    const scheduler = build();
    await scheduler.joinNow("e0");
    expect(joined).toEqual(["e0"]);
    mode = "join";
    await tickAt(scheduler, START - 30_000);
    expect(joined).toEqual(["e0"]);
  });

  it("should not open a meeting again when it's moved after you joined it", async () => {
    meetings({});
    const scheduler = build();
    await tickAt(scheduler, START - 60_000);
    await tickAt(scheduler, START - 30_000);
    meetings({ start: START + 3 * 60_000, end: START + 33 * 60_000 });
    await tickAt(scheduler, START + 2 * 60_000);
    await tickAt(scheduler, START + 3 * 60_000);
    expect(joined).toEqual(["e0"]);
    expect(notices).toHaveLength(1);
  });

  it("should join only one of two meetings starting at the same time", async () => {
    meetings({ title: "A", joinUrl: "https://meet.google.com/aaa-aaaa-aaa" }, { title: "B", joinUrl: "https://meet.google.com/bbb-bbbb-bbb" });
    const scheduler = build();
    await tickAt(scheduler, START - 60_000);
    await tickAt(scheduler, START - 30_000);
    expect(joined).toEqual(["e0"]);
    expect(calendar.getJoin("e1", START)).toBe("skipped");
  });

  it("should not put the notice back up while Join now is opening the meeting", async () => {
    meetings({});
    let finishJoin = () => {};
    const scheduler = new JoinScheduler({
      calendar,
      joinMode: () => "join",
      notify: (event, joinAt, onSkip) => {
        notices.push({ title: event.title, joinAt, skip: onSkip, closed: false });
        return { close: () => {} };
      },
      remind: () => ({ close: () => {} }),
      join: (event) =>
        new Promise<void>((resolve) => {
          joined.push(event.eventId);
          finishJoin = resolve;
        }),
      reportFailure: () => {},
      onChange: () => {},
      now: () => clock,
    });
    clock = START - 45_000;
    const pending = scheduler.joinNow("e0");
    scheduler.tick();
    await scheduler.joinNow("e0");
    finishJoin();
    await pending;
    scheduler.tick();
    expect(notices).toHaveLength(0);
    expect(joined).toEqual(["e0"]);
  });

  it("should not join a meeting that has already ended", async () => {
    meetings({ end: START + 2 * 60_000 });
    const scheduler = build();
    await tickAt(scheduler, START + 3 * 60_000);
    expect(notices).toHaveLength(0);
  });

  it("should list each coming meeting with when it'll be joined", () => {
    meetings({ title: "Standup" });
    expect(build().meetings()).toEqual([
      {
        eventId: "e0",
        title: "Standup",
        start: START,
        end: START + 30 * 60_000,
        provider: "meet",
        state: "will-join",
        joinAt: START - 30_000,
      },
    ]);
  });

  it("should only show a click-to-join notice at the join time when set to notify, and join when it's clicked", async () => {
    meetings({ title: "Standup" });
    mode = "notify";
    const scheduler = build();
    await tickAt(scheduler, START - 60_000);
    expect(reminders).toHaveLength(0);
    expect(scheduler.meetings()[0].state).toBe("will-notify");
    await tickAt(scheduler, START - 30_000);
    await tickAt(scheduler, START - 29_000);
    expect(notices).toHaveLength(0);
    expect(joined).toEqual([]);
    expect(reminders.map((reminder) => reminder.title)).toEqual(["Standup"]);
    expect(scheduler.meetings()[0].state).toBe("notified");

    reminders[0].join();
    await tickAt(scheduler, START - 28_000);
    expect(joined).toEqual(["e0"]);
    expect(scheduler.meetings()[0].state).toBe("joined");
  });

  it("should not join a meeting it already notified you about when the setting changes to join", async () => {
    meetings({});
    mode = "notify";
    const scheduler = build();
    await tickAt(scheduler, START - 30_000);
    mode = "join";
    await tickAt(scheduler, START - 10_000);
    await tickAt(scheduler, START + 30_000);
    expect(joined).toEqual([]);
    expect(notices).toHaveLength(0);
  });

  it("should not notify you about a skipped meeting, and take the notice down once a meeting ends", async () => {
    meetings({ title: "A" }, { title: "B", start: START + 60 * 60_000, end: START + 90 * 60_000 });
    mode = "notify";
    const scheduler = build();
    scheduler.skip("e1");
    await tickAt(scheduler, START - 30_000);
    await tickAt(scheduler, START + 60 * 60_000 - 30_000);
    expect(reminders.map((reminder) => reminder.title)).toEqual(["A"]);
    expect(reminders[0].closed).toBe(true);
  });

  it("should report a click-to-join that couldn't open the meeting", async () => {
    meetings({});
    mode = "notify";
    joinError = new Error("Couldn't open Google Chrome. Is it installed?");
    const scheduler = build();
    await tickAt(scheduler, START - 30_000);
    reminders[0].join();
    await tickAt(scheduler, START - 29_000);
    expect(failures).toEqual(["Couldn't open Google Chrome. Is it installed?"]);
  });
});
