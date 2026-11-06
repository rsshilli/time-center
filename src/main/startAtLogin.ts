import type { Store } from "./store/Store";

/** Records that start-at-login was switched on once, so a later "off" in System Settings sticks. */
export const START_AT_LOGIN_SETTING = "startAtLogin.enabledOnce";

/** The two pieces of Electron's `app` this needs, so tests can pass fakes. */
export interface LoginItems {
  /** True when running the installed app rather than a dev build. */
  isPackaged: boolean;
  /** Electron's `app.setLoginItemSettings`. */
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

/**
 * Adds the installed app to the Mac's login items the first time it runs, so Time Center starts when
 * the user logs in. Only ever done once: if the user later removes it in System Settings → General →
 * Login Items, it stays removed. Dev builds are never added.
 * @param store Where the "already done" flag lives.
 * @param loginItems Electron's `app`, or a fake in tests.
 * @returns True when it added the login item on this call.
 */
export function enableStartAtLoginOnce(store: Store, loginItems: LoginItems): boolean {
  if (!loginItems.isPackaged || store.getSetting(START_AT_LOGIN_SETTING) !== null) {
    return false;
  }
  loginItems.setLoginItemSettings({ openAtLogin: true });
  store.setSetting(START_AT_LOGIN_SETTING, new Date().toISOString());
  return true;
}
