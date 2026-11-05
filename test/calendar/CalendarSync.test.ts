import { CalendarStore } from "../../src/main/calendar/CalendarStore";
import { CalendarSync, GOOGLE_ACCOUNT_SETTING } from "../../src/main/calendar/CalendarSync";
import type { GoogleEvent } from "../../src/main/calendar/meetingLinks";
import { Store } from "../../src/main/store/Store";

const NOW = Date.parse("2026-11-05T14:00:00Z");

describe("CalendarSync", () => {
  let store: Store;
  let calendar: CalendarStore;
  let events: GoogleEvent[];
  let failWith: Error | null;
  let synced: number;

  beforeEach(() => {
    store = new Store(":memory:");
    calendar = new CalendarStore(store.db);
    events = [];
    failWith = null;
    synced = 0;
  });

  afterEach(() => store.close());

  /**
   * A sync on a fake Google client.
   * @param signedIn Whether a sign-in is kept.
   * @returns The sync.
   */
  const build = (signedIn = true) =>
    new CalendarSync({
      client: {
        listEvents: async () => {
          if (failWith) {
            throw failWith;
          }
          return events;
        },
        getAccount: async () => "ryan@example.com",
      },
      calendar,
      settings: store,
      isSignedIn: () => signedIn,
      onSynced: () => synced++,
      now: () => NOW,
    });

  /**
   * A timed Google event.
   * @param id Its id.
   * @param startIso Its start.
   * @returns The event.
   */
  const event = (id: string, startIso: string): GoogleEvent => ({
    id,
    summary: id,
    start: { dateTime: startIso },
    end: { dateTime: new Date(Date.parse(startIso) + 1_800_000).toISOString() },
    hangoutLink: "https://meet.google.com/abc-defg-hij",
  });

  it("should store the coming meetings and learn the account", async () => {
    events = [event("a", "2026-11-05T15:00:00Z"), { ...event("allday", "2026-11-05T00:00:00Z"), start: { date: "2026-11-05" } }];
    const sync = build();
    await sync.syncNow();
    expect(calendar.listEvents(NOW, NOW + 86_400_000).map((row) => row.eventId)).toEqual(["a"]);
    expect(store.getSetting(GOOGLE_ACCOUNT_SETTING)).toBe("ryan@example.com");
    expect(sync.status()).toEqual({ lastSyncAt: NOW, lastError: null });
    expect(synced).toBe(1);
  });

  it("should drop a meeting that was deleted or moved away since the last sync", async () => {
    events = [event("a", "2026-11-05T15:00:00Z"), event("b", "2026-11-05T16:00:00Z")];
    const sync = build();
    await sync.syncNow();
    events = [event("a", "2026-11-05T15:30:00Z")];
    await sync.syncNow();
    expect(calendar.listEvents(NOW, NOW + 86_400_000).map((row) => [row.eventId, row.start])).toEqual([
      ["a", Date.parse("2026-11-05T15:30:00Z")],
    ]);
  });

  it("should keep the last copy and show the error when Google can't be reached", async () => {
    events = [event("a", "2026-11-05T15:00:00Z")];
    const sync = build();
    await sync.syncNow();
    failWith = new Error("fetch failed");
    await sync.syncNow();
    expect(calendar.listEvents(NOW, NOW + 86_400_000)).toHaveLength(1);
    expect(sync.status().lastError).toBe("fetch failed");
  });

  it("should do nothing until signed in", async () => {
    events = [event("a", "2026-11-05T15:00:00Z")];
    await build(false).syncNow();
    expect(calendar.listEvents(NOW, NOW + 86_400_000)).toEqual([]);
    expect(synced).toBe(0);
  });
});
