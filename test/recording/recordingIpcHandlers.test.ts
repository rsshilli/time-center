import type { RecordingIpcDependencies } from "../../src/main/recording/recordingIpc";
import { IPC } from "../../src/shared/ipc";

/** The handlers registered with the fake ipcMain, by channel. */
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  BrowserWindow: { fromWebContents: () => null },
}));

const { registerRecordingIpc } = await import("../../src/main/recording/recordingIpc");

describe("registerRecordingIpc", () => {
  let dismiss: ReturnType<typeof vi.fn>;
  let restore: ReturnType<typeof vi.fn>;
  let catchUp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers.clear();
    dismiss = vi.fn();
    restore = vi.fn();
    catchUp = vi.fn(async () => ({ summary: "- ok" }));
    registerRecordingIpc({ dismissed: { dismiss, restore }, catchUp, now: () => 42 } as unknown as RecordingIpcDependencies);
  });

  /**
   * Calls a handler the way the renderer would.
   * @param channel The IPC channel.
   * @param args What the renderer sent.
   * @returns The handler's answer.
   */
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);

  it("should dismiss and restore a checked suggestion, and refuse a bad one before it reaches the store", () => {
    const ref = { recordingId: 3, saidAt: 1_000, text: "You: send the keys" };

    call(IPC.dismissSuggestion, ref);
    call(IPC.restoreSuggestion, ref);

    expect(dismiss).toHaveBeenCalledWith(ref, 42);
    expect(restore).toHaveBeenCalledWith(ref);
    expect(() => call(IPC.dismissSuggestion, { ...ref, text: "" })).toThrow();
    expect(() => call(IPC.restoreSuggestion, { ...ref, recordingId: -1 })).toThrow();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("should catch up on a call only for 2, 5 or 10 minutes", async () => {
    await call(IPC.catchUpOnCall, 3, 5);

    expect(catchUp).toHaveBeenCalledWith(3, 5);
    expect(() => call(IPC.catchUpOnCall, 3, 7)).toThrow();
    expect(() => call(IPC.catchUpOnCall, "3", 5)).toThrow();
    expect(catchUp).toHaveBeenCalledTimes(1);
  });
});
