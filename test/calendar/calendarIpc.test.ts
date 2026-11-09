import { ipcMain } from "electron";
import {
  assertEventId,
  buildCalendarStatus,
  readJoinMode,
  registerCalendarIpc,
  type CalendarIpcDeps,
} from "../../src/main/calendar/calendarIpc";
import { IPC, type CalendarStatus } from "../../src/shared/ipc";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

describe("calendarIpc", () => {
  it("should start by joining automatically, read the old switch's false as off, and read notify", () => {
    expect(readJoinMode({ getSetting: () => null })).toBe("join");
    expect(readJoinMode({ getSetting: () => "false" })).toBe("off");
    expect(readJoinMode({ getSetting: () => "notify" })).toBe("notify");
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
      joinMode: "join",
      lastSyncAt: null,
      lastError: null,
      meetings: [],
    });
  });

  it("should store each join mode the Settings screen picks and refuse anything else", () => {
    const settings = new Map<string, string | null>();
    const deps = {
      auth: { hasClient: () => true, isSignedIn: () => false },
      sync: { status: () => ({ lastSyncAt: null, lastError: null }), account: () => null },
      scheduler: { meetings: () => [], tick: vi.fn() },
      settings: { getSetting: (key: string) => settings.get(key) ?? null, setSetting: (key: string, value: string | null) => settings.set(key, value) },
      pickClientFile: async () => null,
      onChange: vi.fn(),
    } as unknown as CalendarIpcDeps;
    registerCalendarIpc(deps);
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === IPC.setJoinMode)?.[1];
    if (!handler) {
      throw new Error("No setJoinMode handler");
    }
    for (const mode of ["notify", "off", "join"] as const) {
      expect((handler({} as never, mode) as CalendarStatus).joinMode).toBe(mode);
    }
    expect(() => handler({} as never, true)).toThrow(/join, notify or off/);
    expect(deps.scheduler.tick).toHaveBeenCalledTimes(3);
  });
});
