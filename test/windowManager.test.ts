export {};

const made: FakeWindow[] = [];

/** A stand-in for Electron's window, recording what was asked of it. */
class FakeWindow {
  calls: string[] = [];
  destroyed = false;
  webContents = {
    setWindowOpenHandler: () => {},
    on: () => {},
    executeJavaScript: async (code: string) => {
      this.calls.push(code);
    },
  };

  constructor() {
    made.push(this);
  }

  /** Records a load. */
  async loadFile(_file: string, options: { hash: string }): Promise<void> {
    this.calls.push(`load ${options.hash}`);
  }

  /** Records a load from the dev server. */
  async loadURL(url: string): Promise<void> {
    this.calls.push(`load ${url.split("#")[1]}`);
  }

  /** Records showing. */
  show(): void {
    this.calls.push("show");
  }

  /** Records focusing. */
  focus(): void {
    this.calls.push("focus");
  }

  /** Whether it was closed. */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Ignores window events. */
  on(): void {}
}

vi.mock("electron", () => ({ BrowserWindow: FakeWindow, shell: { openExternal: async () => {} } }));

const { WindowManager } = await import("../src/main/WindowManager");

describe("WindowManager.bringForward", () => {
  beforeEach(() => {
    made.length = 0;
  });

  it("should open My time when no window is open, as a click on the Dock icon", () => {
    new WindowManager().bringForward();

    expect(made).toHaveLength(1);
    expect(made[0].calls).toEqual(expect.arrayContaining(["load /dashboard", "show", "focus"]));
  });

  it("should bring the open window forward on the screen it was left on, without switching it", () => {
    const windows = new WindowManager();
    windows.show("todos");
    made[0].calls.length = 0;

    windows.bringForward();

    expect(made).toHaveLength(1);
    expect(made[0].calls).toEqual(["show", "focus"]);
  });

  it("should open a new window once the old one was closed", () => {
    const windows = new WindowManager();
    windows.show("todos");
    made[0].destroyed = true;

    windows.bringForward();

    expect(made).toHaveLength(2);
  });
});
