import { ActivityStore } from "../src/main/activity/ActivityStore";
import { STARTER_RULES } from "../src/main/activity/classify";
import { DEFAULT_IGNORED_APPS } from "../src/main/activity/ignoredApps";
import type { IpcDependencies } from "../src/main/ipcHandlers";
import { Store } from "../src/main/store/Store";
import { IPC } from "../src/shared/ipc";

/** The handlers registered with the fake ipcMain, by channel. */
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler) },
}));

const { registerIpcHandlers } = await import("../src/main/ipcHandlers");

describe("registerIpcHandlers", () => {
  let store: Store;
  let restarts: number;

  beforeEach(() => {
    handlers.clear();
    store = new Store(":memory:");
    restarts = 0;
    registerIpcHandlers({
      store,
      activity: new ActivityStore(store.db),
      onIgnoredAppsChanged: () => restarts++,
    } as unknown as IpcDependencies);
  });

  afterEach(() => {
    store.close();
  });

  /**
   * Calls a handler the way the renderer would.
   * @param channel The IPC channel.
   * @param args What the renderer sent.
   * @returns The handler's answer.
   */
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);

  it("should hand out the starter rules until rules are saved, then the saved ones", () => {
    expect(call(IPC.getRules)).toEqual(STARTER_RULES);
    const rules = [{ field: "app", pattern: "Figma", category: "Design" }];
    expect(call(IPC.saveRules, rules)).toEqual(rules);
    expect(call(IPC.getRules)).toEqual(rules);
  });

  it("should refuse to save rules the renderer got wrong", () => {
    expect(() => call(IPC.saveRules, [{ field: "nope", pattern: "x", category: "y" }])).toThrow();
    expect(call(IPC.getRules)).toEqual(STARTER_RULES);
  });

  it("should ignore Edge until the list is changed, then restart the window helper on save", () => {
    expect(call(IPC.getIgnoredApps)).toEqual([...DEFAULT_IGNORED_APPS]);
    expect(call(IPC.saveIgnoredApps, ["com.microsoft.edgemac", " Signal "])).toEqual(["com.microsoft.edgemac", "Signal"]);
    expect(call(IPC.getIgnoredApps)).toEqual(["com.microsoft.edgemac", "Signal"]);
    expect(restarts).toBe(1);
  });

  it("should neither save nor restart when the ignored apps are malformed", () => {
    expect(() => call(IPC.saveIgnoredApps, "Signal")).toThrow();
    expect(call(IPC.getIgnoredApps)).toEqual([...DEFAULT_IGNORED_APPS]);
    expect(restarts).toBe(0);
  });
});
