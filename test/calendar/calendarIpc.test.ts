import { assertEventId, buildCalendarStatus, isAutoJoinOn, type CalendarIpcDeps } from "../../src/main/calendar/calendarIpc";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

describe("calendarIpc", () => {
  it("should start with auto-join on and turn it off only on an explicit false", () => {
    expect(isAutoJoinOn({ getSetting: () => null })).toBe(true);
    expect(isAutoJoinOn({ getSetting: () => "false" })).toBe(false);
  });

  it("should accept Google event ids, including a repeating meeting's occurrence", () => {
    expect(assertEventId("7kq1v9h3_20261105T150000Z")).toBe("7kq1v9h3_20261105T150000Z");
  });

  it("should refuse anything from the renderer that isn't an event id", () => {
    expect(() => assertEventId(42)).toThrow(/Not a meeting id/);
    expect(() => assertEventId("../../etc")).toThrow(/Not a meeting id/);
    expect(() => assertEventId("")).toThrow(/Not a meeting id/);
  });

  it("should list no meetings and no account while signed out", () => {
    const status = buildCalendarStatus({
      auth: { hasClient: () => true, isSignedIn: () => false },
      sync: { status: () => ({ lastSyncAt: null, lastError: null }), account: () => "old@example.com" },
      scheduler: { meetings: () => [{ eventId: "x" }] },
      settings: { getSetting: () => null },
    } as unknown as CalendarIpcDeps);
    expect(status).toEqual({
      hasClient: true,
      signedIn: false,
      account: null,
      autoJoin: true,
      lastSyncAt: null,
      lastError: null,
      meetings: [],
    });
  });
});
