import { START_AT_LOGIN_SETTING, enableStartAtLoginOnce, type LoginItems } from "../src/main/startAtLogin";
import { Store } from "../src/main/store/Store";

describe("enableStartAtLoginOnce", () => {
  it("should add the installed app to login items on its first run", () => {
    const store = new Store(":memory:");
    const items = fakeLoginItems(true);

    expect(enableStartAtLoginOnce(store, items)).toBe(true);
    expect(items.calls).toEqual([{ openAtLogin: true }]);
    expect(store.getSetting(START_AT_LOGIN_SETTING)).not.toBeNull();
  });

  it("should not add it again once done, so turning it off in System Settings sticks", () => {
    const store = new Store(":memory:");
    enableStartAtLoginOnce(store, fakeLoginItems(true));
    const items = fakeLoginItems(true);

    expect(enableStartAtLoginOnce(store, items)).toBe(false);
    expect(items.calls).toEqual([]);
  });

  it("should leave dev builds out of login items", () => {
    const store = new Store(":memory:");
    const items = fakeLoginItems(false);

    expect(enableStartAtLoginOnce(store, items)).toBe(false);
    expect(items.calls).toEqual([]);
    expect(store.getSetting(START_AT_LOGIN_SETTING)).toBeNull();
  });
});

/**
 * A stand-in for Electron's `app` that records each login-item change.
 * @param isPackaged Whether to act as the installed app.
 * @returns The fake, with the calls it received.
 */
function fakeLoginItems(isPackaged: boolean): LoginItems & { calls: { openAtLogin: boolean }[] } {
  const calls: { openAtLogin: boolean }[] = [];
  return {
    isPackaged,
    calls,
    setLoginItemSettings: (settings) => {
      calls.push(settings);
    },
  };
}
