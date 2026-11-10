import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, shell } from "electron";

/** The screens the single app window can show. */
export type Screen = "dashboard" | "recordings" | "todos" | "permissions" | "settings";

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
    // A link clicked in a TODO opens in your browser; the window itself never leaves the app or opens another.
    window.webContents.setWindowOpenHandler(({ url }) => {
      openIfExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (!isAppPage(url)) {
        event.preventDefault();
        openIfExternal(url);
      }
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

/**
 * Opens a web or email link in the default app; anything else (file:, javascript:, custom schemes) is ignored.
 * @param url The link.
 */
function openIfExternal(url: string): void {
  if (isExternalLink(url)) {
    void shell.openExternal(url);
  }
}

/**
 * Whether a link is one to hand to the browser or mail app.
 * @param url The link.
 * @returns True for http, https and mailto.
 */
export function isExternalLink(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol) && !isAppPage(url);
  } catch {
    return false;
  }
}

/**
 * Whether a link is the app's own window page: the Vite dev server's origin during `npm run dev`, or the
 * built renderer's index.html. The window may only ever load these.
 * @param url The link.
 * @returns True for the app's own page.
 */
export function isAppPage(url: string): boolean {
  try {
    const target = new URL(url);
    const devServerUrl = process.env.ELECTRON_RENDERER_URL;
    if (devServerUrl) {
      return target.origin === new URL(devServerUrl).origin;
    }
    return target.protocol === "file:" && target.pathname === pathToFileURL(join(__dirname, "../renderer/index.html")).pathname;
  } catch {
    return false;
  }
}
