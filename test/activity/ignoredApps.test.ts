import { DEFAULT_IGNORED_APPS, assertIgnoredApps, parseIgnoredApps } from "../../src/main/activity/ignoredApps";

describe("parseIgnoredApps", () => {
  it("should fall back to Edge when nothing is saved", () => {
    expect(parseIgnoredApps(null)).toEqual([...DEFAULT_IGNORED_APPS]);
  });

  it("should fall back to Edge when the saved list is damaged", () => {
    expect(parseIgnoredApps("{not json")).toEqual([...DEFAULT_IGNORED_APPS]);
    expect(parseIgnoredApps('[1, 2]')).toEqual([...DEFAULT_IGNORED_APPS]);
  });

  it("should keep a saved empty list, which ignores nothing", () => {
    expect(parseIgnoredApps("[]")).toEqual([]);
  });
});

describe("assertIgnoredApps", () => {
  it("should trim entries and drop blanks and repeats", () => {
    expect(assertIgnoredApps([" com.microsoft.edgemac ", "", "Signal", "Signal"])).toEqual([
      "com.microsoft.edgemac",
      "Signal",
    ]);
  });

  it("should reject a comma, which would split one entry into two for the helper", () => {
    expect(() => assertIgnoredApps(["Slack, Signal"])).toThrow(/comma/);
  });

  it("should reject anything that isn't a list of text", () => {
    expect(() => assertIgnoredApps("Signal")).toThrow();
    expect(() => assertIgnoredApps([3])).toThrow();
  });
});
