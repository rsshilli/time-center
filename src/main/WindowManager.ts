import { join } from "node:path";
import { BrowserWindow } from "electron";

/** The screens the single app window can show. */
export type Screen = "dashboard" | "recordings" | "permissions" | "settings";

/**
 * Owns the one app window. It is created when needed and destroyed (not hidden) when closed, so the
 * tray app holds no renderer in memory while you're not looking at it.
 */
export class WindowManager {
  private window: BrowserWindow | null = null;

  /**
   * Shows a screen, creating the window if it isn't open and focusing it either way.
   * @param screen Which screen to show.
   */
  show(screen: Screen): void {
    if (!this.window || this.window.isDestroyed()) {
      this.window = this.createWindow();
      this.load(this.window, screen).catch((error: unknown) => {
        console.error("Time Center: the window failed to load", error);
      });
    } else {
      // Switching screens in an open window changes only the hash: no reload, so nothing typed is lost
      // and two quick clicks can't abort each other's page load.
      void this.window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#/${screen}`)}`);
    }
    this.window.show();
    this.window.focus();
  }

  /**
   * Builds the window with a sandboxed renderer that can reach the main process only via the preload bridge.
   * @returns The window.
   */
  private createWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: 1000,
      height: 820,
      title: "Time Center",
      show: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.on("closed", () => {
      this.window = null;
    });
    return window;
  }

  /**
   * Loads the renderer at a screen: the Vite dev server during `npm run dev`, the built file otherwise.
   * @param window The window.
   * @param screen The screen, passed as the URL hash.
   */
  private async load(window: BrowserWindow, screen: Screen): Promise<void> {
    const devServerUrl = process.env.ELECTRON_RENDERER_URL;
    if (devServerUrl) {
      await window.loadURL(`${devServerUrl}#/${screen}`);
      return;
    }
    await window.loadFile(join(__dirname, "../renderer/index.html"), { hash: `/${screen}` });
  }
}
