import { Permissions, mapMediaStatus, type PermissionsPlatform } from "../../src/main/permissions/Permissions";

describe("Permissions", () => {
  it("should not need attention when everything macOS can report is allowed", () => {
    const { platform } = fakePlatform();
    expect(new Permissions(platform).needsAttention()).toBe(false);
  });

  it("should need attention when any permission is denied or not yet asked", () => {
    const { platform } = fakePlatform({ getMediaAccessStatus: (type) => (type === "microphone" ? "not-determined" : "granted") });
    expect(new Permissions(platform).needsAttention()).toBe(true);
  });

  it("should show Accessibility and Screen Recording as not yet allowed, since macOS only answers yes or no for them", () => {
    const { platform } = fakePlatform({
      isTrustedAccessibilityClient: () => false,
      getMediaAccessStatus: (type) => (type === "screen" ? "denied" : "granted"),
    });
    const statuses = new Permissions(platform).getAll();
    expect(statuses.find((s) => s.kind === "accessibility")?.state).toBe("not-determined");
    expect(statuses.find((s) => s.kind === "screen")?.state).toBe("not-determined");
  });

  it("should mark Chrome automation denied when macOS refuses Apple events", async () => {
    const { platform } = fakePlatform({
      runAppleScript: async () => {
        throw new Error("execution error: Not authorized to send Apple events to Google Chrome. (-1743)");
      },
    });
    const statuses = await new Permissions(platform).request("automation");
    expect(statuses.find((s) => s.kind === "automation")?.state).toBe("denied");
  });

  it("should leave Chrome automation unknown when Chrome isn't running", async () => {
    const { platform } = fakePlatform({ runAppleScript: async () => "not-running\n" });
    const statuses = await new Permissions(platform).request("automation");
    expect(statuses.find((s) => s.kind === "automation")?.state).toBe("unknown");
  });

  it("should mark Chrome automation granted when Chrome answers", async () => {
    const { platform } = fakePlatform();
    const statuses = await new Permissions(platform).request("automation");
    expect(statuses.find((s) => s.kind === "automation")?.state).toBe("granted");
  });

  it("should read Chrome's saved answer without asking, so a restart doesn't show it as not checked", async () => {
    let probes = 0;
    const { platform } = fakePlatform({
      runAppleScript: async () => {
        probes++;
        return "1";
      },
    });
    const permissions = new Permissions(platform);
    expect(permissions.getAll().find((s) => s.kind === "automation")?.state).toBe("unknown");

    await permissions.refreshAutomation();

    expect(permissions.getAll().find((s) => s.kind === "automation")?.state).toBe("granted");
    expect(probes).toBe(0);
  });

  it("should remember Chrome's last answer and keep it while Chrome is closed", async () => {
    const saved: string[] = [];
    const memory = { load: () => saved.at(-1) ?? null, save: (state: string) => void saved.push(state) };
    let answer = "denied";
    const { platform } = fakePlatform({ readChromeAutomation: async () => answer });

    await new Permissions(platform, memory).refreshAutomation();
    answer = "not-running";
    const restarted = new Permissions(platform, memory);
    await restarted.refreshAutomation();

    expect(saved).toEqual(["denied"]);
    expect(restarted.getAll().find((s) => s.kind === "automation")?.state).toBe("denied");
    expect(restarted.needsAttention()).toBe(true);
  });

  it("should keep the last answer when the helper fails or says something new", async () => {
    const memory = { load: () => "granted", save: () => undefined };
    const failing = new Permissions(fakePlatform({ readChromeAutomation: async () => Promise.reject(new Error("no helper")) }).platform, memory);
    const odd = new Permissions(fakePlatform({ readChromeAutomation: async () => "unknown -50" }).platform, memory);
    await failing.refreshAutomation();
    await odd.refreshAutomation();
    expect(failing.getAll().find((s) => s.kind === "automation")?.state).toBe("granted");
    expect(odd.getAll().find((s) => s.kind === "automation")?.state).toBe("granted");
    expect(new Permissions(fakePlatform().platform, { load: () => "junk", save: () => undefined }).getAll().at(-1)?.state).toBe("unknown");
  });

  it("should try a screen capture on the first Screen Recording ask, then open its settings pane", async () => {
    let captures = 0;
    const { platform, opened } = fakePlatform({
      requestScreenCapture: async () => {
        captures++;
      },
    });
    const permissions = new Permissions(platform);

    await permissions.request("screen");
    expect(captures).toBe(1);
    expect(opened).toEqual([]);

    await permissions.request("screen");
    expect(captures).toBe(1);
    expect(opened).toEqual(["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);
  });
});

describe("mapMediaStatus", () => {
  it("should map macOS media statuses onto the app's permission states", () => {
    expect(mapMediaStatus("granted")).toBe("granted");
    expect(mapMediaStatus("restricted")).toBe("denied");
    expect(mapMediaStatus("denied")).toBe("denied");
    expect(mapMediaStatus("not-determined")).toBe("not-determined");
    expect(mapMediaStatus("something-new")).toBe("unknown");
  });
});

/**
 * Builds a fake macOS that records what was opened and asked.
 * @param overrides Behaviour to change from "everything granted".
 * @returns The fake and the URLs it was asked to open.
 */
function fakePlatform(overrides: Partial<PermissionsPlatform> = {}): { platform: PermissionsPlatform; opened: string[] } {
  const opened: string[] = [];
  const platform: PermissionsPlatform = {
    isTrustedAccessibilityClient: () => true,
    getMediaAccessStatus: () => "granted",
    askForMediaAccess: async () => true,
    requestScreenCapture: async () => undefined,
    openExternal: async (url) => {
      opened.push(url);
    },
    runAppleScript: async () => "1",
    readChromeAutomation: async () => "granted\n",
    ...overrides,
  };
  return { platform, opened };
}
