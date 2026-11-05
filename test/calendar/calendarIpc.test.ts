import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEventId, buildCalendarStatus, isAutoJoinOn, type CalendarIpcDeps } from "../../src/main/calendar/calendarIpc";
import { installExtensionCopy } from "../../src/main/calendar/extensionFolder";

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
      extensionPath: "/ext",
    } as unknown as CalendarIpcDeps);
    expect(status).toEqual({
      hasClient: true,
      signedIn: false,
      account: null,
      autoJoin: true,
      lastSyncAt: null,
      lastError: null,
      extensionPath: "/ext",
      meetings: [],
    });
  });
});

describe("installExtensionCopy", () => {
  it("should copy the manifest and built script into the fixed folder with the key, replacing an old copy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc-ext-"));
    try {
      const source = join(dir, "source");
      const destination = join(dir, "chrome-extension");
      await mkdir(join(source, "build"), { recursive: true });
      await writeFile(join(source, "manifest.json"), '{"manifest_version":3}');
      await writeFile(join(source, "build", "join.js"), "new();");
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "stale.js"), "old();");

      await installExtensionCopy(source, destination, "ab".repeat(32));

      expect(await readFile(join(destination, "build", "join.js"), "utf8")).toBe("new();");
      expect(await readFile(join(destination, "manifest.json"), "utf8")).toContain("manifest_version");
      await expect(readFile(join(destination, "stale.js"))).rejects.toThrow();
      expect(await readFile(join(destination, "build", "key.js"), "utf8")).toBe(`self.timeCenterKey = "${"ab".repeat(32)}";\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
